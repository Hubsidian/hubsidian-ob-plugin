// Sync engine: scans both sides, feeds the pure planner, executes the plan
// through DavClient + the vault adapter, and maintains the per-path sync
// records that make deletion/conflict detection possible on the next run.

import { normalizePath, type App, type DataAdapter } from "obsidian";
import {
  checkMassDelete,
  computePlan,
  type LocalFileState,
  type SyncAction,
  type SyncRecord,
} from "./planner";
import type { DavClient } from "./webdav";
import type { HubsidianSettings } from "./types";

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: string[];
  errors: string[];
}

const CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
};

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Skip rule shared by both scans: dot-segments (config dirs, .git, .trash —
 * the plugin's own tokens live under .obsidian and must never sync) and the
 * user's excluded folders. */
export function makeSkip(settings: HubsidianSettings): (path: string) => boolean {
  const excludes = settings.excludeFolders.map((f) => f.replace(/\/+$/, "")).filter(Boolean);
  return (path: string) => {
    if (path.split("/").some((seg) => seg.startsWith("."))) return true;
    return excludes.some((ex) => path === ex || path.startsWith(`${ex}/`));
  };
}

async function scanLocal(
  adapter: DataAdapter,
  skip: (path: string) => boolean,
): Promise<{ files: Map<string, LocalFileState>; dirs: Set<string> }> {
  const files = new Map<string, LocalFileState>();
  const dirs = new Set<string>();
  const queue = ["/"];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const listing = await adapter.list(dir);
    for (const folder of listing.folders) {
      const path = normalizePath(folder);
      if (skip(path)) continue;
      dirs.add(path);
      queue.push(path);
    }
    for (const file of listing.files) {
      const path = normalizePath(file);
      if (skip(path)) continue;
      const stat = await adapter.stat(path);
      if (stat?.type === "file") files.set(path, { mtimeMs: stat.mtime, size: stat.size });
    }
  }
  return { files, dirs };
}

/** Small promise pool: transfers run a few at a time, order-independent. */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export class SyncEngine {
  private running = false;

  constructor(
    private readonly app: App,
    private readonly dav: DavClient,
    private readonly getSettings: () => HubsidianSettings,
    private readonly getRecords: () => Record<string, SyncRecord>,
    private readonly saveRecords: (records: Record<string, SyncRecord>) => Promise<void>,
    private readonly onProgress: (text: string) => void = () => {},
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  async run(): Promise<SyncSummary> {
    if (this.running) throw new Error("A sync is already running.");
    this.running = true;
    try {
      return await this.doRun();
    } finally {
      this.running = false;
    }
  }

  private async doRun(): Promise<SyncSummary> {
    const adapter = this.app.vault.adapter;
    const skip = makeSkip(this.getSettings());
    const records = this.getRecords();

    this.onProgress("scanning…");
    const [local, remote] = await Promise.all([
      scanLocal(adapter, skip),
      this.dav.listAll(skip),
    ]);

    const plan = computePlan({
      localFiles: local.files,
      localDirs: local.dirs,
      remoteFiles: remote.files,
      remoteDirs: remote.dirs,
      records,
    });

    // Mass-delete guard: a wiped/renamed remote (or a gutted local vault)
    // must not silently cascade into deleting the other side.
    const guard = checkMassDelete(
      plan,
      local.files.size,
      remote.files.size,
      this.getSettings().massDeleteThresholdPercent,
    );
    if (guard) {
      throw new Error(
        `aborted — this sync would delete ${guard.count} of ${guard.total} ${guard.side} files. ` +
          "If the wipe was intentional, use Reset sync state to re-baseline without deletions, " +
          "or raise/disable the mass-delete guard in settings to let the deletions through.",
      );
    }
    const conflictPaths = new Set(plan.conflicts);

    // Seed the next snapshot with everything untouched by the plan.
    const touched = new Set(plan.actions.map((a) => a.path));
    const newRecords: Record<string, SyncRecord> = {};
    for (const [path, rec] of Object.entries(records)) {
      if (touched.has(path) || plan.forget.includes(path)) continue;
      const stillFile = rec.kind === "file" && local.files.has(path) && remote.files.has(path);
      const stillDir = rec.kind === "dir" && local.dirs.has(path) && remote.dirs.has(path);
      if (stillFile || stillDir) newRecords[path] = rec;
    }
    // Dirs that exist on both sides but were never recorded (e.g. created by
    // an earlier partial sync) become records now.
    for (const dir of local.dirs) {
      if (remote.dirs.has(dir) && !touched.has(dir) && !newRecords[dir]) {
        newRecords[dir] = { kind: "dir" };
      }
    }

    const summary: SyncSummary = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: plan.conflicts,
      errors: [],
    };

    const keepOldRecord = (path: string) => {
      if (records[path]) newRecords[path] = records[path];
    };

    const execute = async (action: SyncAction): Promise<void> => {
      const { path } = action;
      switch (action.type) {
        case "mkdirLocal":
          await this.ensureLocalDir(adapter, path);
          newRecords[path] = { kind: "dir" };
          break;
        case "mkdirRemote":
          await this.dav.mkcol(path);
          newRecords[path] = { kind: "dir" };
          break;
        case "upload": {
          // Conflict where local wins: the remote version is about to be
          // overwritten permanently (R2 has no versioning) — park a copy of
          // it in the vault trash first.
          if (conflictPaths.has(path) && remote.files.has(path)) {
            const remoteBytes = await this.dav.download(path);
            await adapter.writeBinary(await this.vaultTrashPath(adapter, path), remoteBytes);
          }
          const data = await adapter.readBinary(path);
          let etag = await this.dav.upload(path, data, contentTypeFor(path));
          if (etag === null) etag = (await this.dav.stat(path))?.etag ?? null;
          const stat = await adapter.stat(path);
          newRecords[path] = {
            kind: "file",
            localMtime: stat?.mtime ?? Date.now(),
            localSize: stat?.size ?? data.byteLength,
            remoteEtag: etag,
            remoteMtime: Date.now(),
          };
          summary.uploaded++;
          break;
        }
        case "download": {
          // Conflict where remote wins: the local edits are about to be
          // overwritten — park a copy in the vault trash first (adapter
          // writes bypass Obsidian's File Recovery snapshots).
          if (conflictPaths.has(path) && (await adapter.exists(path))) {
            const localBytes = await adapter.readBinary(path);
            await adapter.writeBinary(await this.vaultTrashPath(adapter, path), localBytes);
          }
          const meta = remote.files.get(path);
          const data = await this.dav.download(path);
          await this.ensureLocalDir(adapter, path.split("/").slice(0, -1).join("/"));
          // Stamp the remote timestamp on the local file, then read back what
          // the platform actually stored — that value is the next scan's
          // change baseline.
          await adapter.writeBinary(path, data, meta ? { mtime: meta.mtimeMs } : undefined);
          const stat = await adapter.stat(path);
          newRecords[path] = {
            kind: "file",
            localMtime: stat?.mtime ?? meta?.mtimeMs ?? Date.now(),
            localSize: stat?.size ?? data.byteLength,
            remoteEtag: meta?.etag ?? `${meta?.mtimeMs}:${meta?.size}`,
            remoteMtime: meta?.mtimeMs ?? Date.now(),
          };
          summary.downloaded++;
          break;
        }
        case "deleteLocal":
          await this.trashLocal(path);
          summary.deletedLocal++;
          break;
        case "deleteRemote":
          await this.dav.remove(path, false);
          summary.deletedRemote++;
          break;
        case "rmdirLocal":
          await this.trashLocal(path);
          break;
        case "rmdirRemote":
          await this.dav.remove(path, true);
          break;
      }
    };

    const guarded = (action: SyncAction) =>
      execute(action).catch((e: unknown) => {
        keepOldRecord(action.path);
        summary.errors.push(`${action.type} ${action.path}: ${e instanceof Error ? e.message : String(e)}`);
      });

    // Phases keep ordering guarantees (parents before children, transfers
    // before deletes, dir removals last); transfers get a small pool.
    const phase = (types: SyncAction["type"][]) =>
      plan.actions.filter((a) => types.includes(a.type));
    for (const action of phase(["mkdirLocal", "mkdirRemote"])) await guarded(action);
    const transfers = phase(["upload", "download"]);
    let done = 0;
    await runPool(transfers, 4, async (action) => {
      await guarded(action);
      done++;
      this.onProgress(`${done}/${transfers.length} files…`);
    });
    for (const action of phase(["deleteLocal", "deleteRemote", "rmdirLocal", "rmdirRemote"])) {
      await guarded(action);
    }

    await this.saveRecords(newRecords);
    return summary;
  }

  private async ensureLocalDir(adapter: DataAdapter, dirPath: string): Promise<void> {
    if (dirPath === "") return;
    const segments = dirPath.split("/");
    let current = "";
    for (const seg of segments) {
      current = current === "" ? seg : `${current}/${seg}`;
      if (!(await adapter.exists(current))) {
        await adapter.mkdir(current);
      }
    }
  }

  /** Delete through Obsidian's trash (user-recoverable) when the file is
   * indexed; move into the vault-local trash otherwise. Sync NEVER deletes
   * local data outright — every path out is a recoverable trash. */
  private async trashLocal(path: string): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (af) {
      await this.app.vault.trash(af, true);
      return;
    }
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(path)) {
      await adapter.rename(path, await this.vaultTrashPath(adapter, path));
    }
  }

  /** Free target path inside the vault-local trash for `path`'s basename
   * (collision-suffixed like Obsidian: "name 2.md", "name 3.md", …). */
  private async vaultTrashPath(adapter: DataAdapter, path: string): Promise<string> {
    const TRASH = ".trash";
    if (!(await adapter.exists(TRASH))) await adapter.mkdir(TRASH);
    const base = path.split("/").pop() ?? path;
    let target = `${TRASH}/${base}`;
    for (let i = 2; await adapter.exists(target); i++) {
      const dot = base.lastIndexOf(".");
      target =
        dot > 0
          ? `${TRASH}/${base.slice(0, dot)} ${i}${base.slice(dot)}`
          : `${TRASH}/${base} ${i}`;
    }
    return target;
  }
}
