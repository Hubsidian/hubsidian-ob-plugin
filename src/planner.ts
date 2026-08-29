// Pure two-way sync planner. Given the current local state, the current
// remote state, and the record of what both sides looked like after the LAST
// sync, decide what to transfer/delete. No IO here — the engine (sync.ts)
// executes the plan and test/planner.test.ts pins the decision table.
//
// Change detection is snapshot-relative (the remotely-save model), never a
// naive local-vs-remote mtime comparison: remote mtimes are upload times, so
// they only break ties in true conflicts (changed on BOTH sides since the
// last sync — newer wins).

export interface LocalFileState {
  mtimeMs: number;
  size: number;
}

export interface RemoteFileState {
  mtimeMs: number;
  size: number;
  etag: string | null;
}

export type SyncRecord =
  | {
      kind: "file";
      localMtime: number;
      localSize: number;
      /** Remote change fingerprint recorded after the last transfer. */
      remoteEtag: string | null;
      remoteMtime: number;
    }
  | { kind: "dir" };

export type SyncAction =
  | { type: "upload"; path: string }
  | { type: "download"; path: string }
  | { type: "deleteLocal"; path: string }
  | { type: "deleteRemote"; path: string }
  | { type: "mkdirLocal"; path: string }
  | { type: "mkdirRemote"; path: string }
  | { type: "rmdirLocal"; path: string }
  | { type: "rmdirRemote"; path: string };

export interface PlanInput {
  localFiles: Map<string, LocalFileState>;
  localDirs: Set<string>;
  remoteFiles: Map<string, RemoteFileState>;
  remoteDirs: Set<string>;
  records: Record<string, SyncRecord>;
}

export interface SyncPlan {
  /** Ordered: mkdirs (shallow→deep), transfers, file deletes, rmdirs (deep→shallow). */
  actions: SyncAction[];
  /** Paths changed on both sides; resolved newer-wins (already in actions). */
  conflicts: string[];
  /** Record keys that refer to paths gone from BOTH sides — drop them. */
  forget: string[];
}

/** Remote change fingerprint: etag when the server provides one (hubsidian
 * always does), else mtime+size. */
export function remoteFingerprint(r: RemoteFileState): string {
  return r.etag ?? `${r.mtimeMs}:${r.size}`;
}

export interface MassDeleteAlert {
  side: "local" | "remote";
  count: number;
  total: number;
}

/**
 * Safety valve against runaway deletion propagation (e.g. the remote store
 * was wiped by hand → every local file would be "deleted remotely"). Flags a
 * plan that deletes at least `minCount` files AND at least `thresholdPercent`
 * of one side's current files. 0 disables the guard.
 */
export function checkMassDelete(
  plan: SyncPlan,
  localFileCount: number,
  remoteFileCount: number,
  thresholdPercent: number,
  minCount = 10,
): MassDeleteAlert | null {
  if (thresholdPercent <= 0) return null;
  const count = (type: SyncAction["type"]) => plan.actions.filter((a) => a.type === type).length;
  const dl = count("deleteLocal");
  const dr = count("deleteRemote");
  if (dl >= minCount && dl * 100 >= localFileCount * thresholdPercent) {
    return { side: "local", count: dl, total: localFileCount };
  }
  if (dr >= minCount && dr * 100 >= remoteFileCount * thresholdPercent) {
    return { side: "remote", count: dr, total: remoteFileCount };
  }
  return null;
}

function depth(p: string): number {
  return p.split("/").length;
}

export function computePlan(input: PlanInput): SyncPlan {
  const { localFiles, localDirs, remoteFiles, remoteDirs, records } = input;
  const conflicts: string[] = [];
  const forget: string[] = [];

  const uploads: string[] = [];
  const downloads: string[] = [];
  const deleteLocals: string[] = [];
  const deleteRemotes: string[] = [];

  const filePaths = new Set<string>([...localFiles.keys(), ...remoteFiles.keys()]);
  for (const rec of Object.keys(records)) {
    if (records[rec].kind === "file") filePaths.add(rec);
  }

  for (const path of filePaths) {
    const local = localFiles.get(path);
    const remote = remoteFiles.get(path);
    const rec = records[path];
    const prev = rec && rec.kind === "file" ? rec : undefined;

    const localChanged =
      !!local && (!prev || local.mtimeMs !== prev.localMtime || local.size !== prev.localSize);
    const remoteChanged = !!remote && (!prev || remoteFingerprint(remote) !== prev.remoteEtag);

    if (local && remote) {
      if (localChanged && remoteChanged) {
        conflicts.push(path);
        if (local.mtimeMs >= remote.mtimeMs) uploads.push(path);
        else downloads.push(path);
      } else if (localChanged) {
        uploads.push(path);
      } else if (remoteChanged) {
        downloads.push(path);
      }
    } else if (local && !remote) {
      // Deleted remotely — but a local edit after the delete wins (resurrect).
      if (prev && !localChanged) deleteLocals.push(path);
      else uploads.push(path);
    } else if (!local && remote) {
      if (prev && !remoteChanged) deleteRemotes.push(path);
      else downloads.push(path);
    } else if (prev) {
      forget.push(path);
    }
  }

  // ── Directories ──────────────────────────────────────────────────────────
  const mkdirLocals: string[] = [];
  const mkdirRemotes: string[] = [];
  const rmdirLocalCandidates = new Set<string>();
  const rmdirRemoteCandidates = new Set<string>();

  const dirPaths = new Set<string>([...localDirs, ...remoteDirs]);
  for (const rec of Object.keys(records)) {
    if (records[rec].kind === "dir") dirPaths.add(rec);
  }

  for (const path of dirPaths) {
    const inLocal = localDirs.has(path);
    const inRemote = remoteDirs.has(path);
    const prevDir = records[path]?.kind === "dir";
    if (inLocal && !inRemote) {
      if (prevDir) rmdirLocalCandidates.add(path);
      else mkdirRemotes.push(path);
    } else if (!inLocal && inRemote) {
      if (prevDir) rmdirRemoteCandidates.add(path);
      else mkdirLocals.push(path);
    } else if (!inLocal && !inRemote && prevDir) {
      forget.push(path);
    }
  }

  // A dir may only be removed when nothing survives under it on that side:
  // no file that will still exist after this sync, and no sub-dir that is
  // itself kept (i.e. not also slated for removal on the same side).
  const finalLocalFiles = new Set<string>(
    [...localFiles.keys()].filter((p) => !deleteLocals.includes(p)).concat(downloads),
  );
  const finalRemoteFiles = new Set<string>(
    [...remoteFiles.keys()].filter((p) => !deleteRemotes.includes(p)).concat(uploads),
  );
  const under = (dir: string, p: string) => p.startsWith(`${dir}/`);
  const blocked = (dir: string, files: Set<string>, dirs: Set<string>, removals: Set<string>) => {
    for (const f of files) if (under(dir, f)) return true;
    for (const d of dirs) if (under(dir, d) && !removals.has(d)) return true;
    return false;
  };
  const rmdirLocals = [...rmdirLocalCandidates].filter(
    (d) => !blocked(d, finalLocalFiles, localDirs, rmdirLocalCandidates),
  );
  const rmdirRemotes = [...rmdirRemoteCandidates].filter(
    (d) => !blocked(d, finalRemoteFiles, remoteDirs, rmdirRemoteCandidates),
  );
  // A blocked removal means the dir survives on the removing side (files got
  // resurrected under it) — recreate it on the other side instead of leaving
  // the two sides disagreeing about the folder.
  for (const d of rmdirLocalCandidates) {
    if (!rmdirLocals.includes(d)) mkdirRemotes.push(d);
  }
  for (const d of rmdirRemoteCandidates) {
    if (!rmdirRemotes.includes(d)) mkdirLocals.push(d);
  }

  const byDepthAsc = (a: string, b: string) => depth(a) - depth(b) || a.localeCompare(b);
  const byDepthDesc = (a: string, b: string) => depth(b) - depth(a) || a.localeCompare(b);

  const actions: SyncAction[] = [
    ...mkdirLocals.sort(byDepthAsc).map((path) => ({ type: "mkdirLocal", path }) as const),
    ...mkdirRemotes.sort(byDepthAsc).map((path) => ({ type: "mkdirRemote", path }) as const),
    ...uploads.sort().map((path) => ({ type: "upload", path }) as const),
    ...downloads.sort().map((path) => ({ type: "download", path }) as const),
    ...deleteLocals.sort().map((path) => ({ type: "deleteLocal", path }) as const),
    ...deleteRemotes.sort().map((path) => ({ type: "deleteRemote", path }) as const),
    ...rmdirLocals.sort(byDepthDesc).map((path) => ({ type: "rmdirLocal", path }) as const),
    ...rmdirRemotes.sort(byDepthDesc).map((path) => ({ type: "rmdirRemote", path }) as const),
  ];

  return { actions, conflicts, forget };
}
