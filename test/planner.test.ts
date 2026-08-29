// Decision table for the pure sync planner. Change detection is
// snapshot-relative; direct local-vs-remote mtime comparison only breaks
// both-changed conflicts (newer wins).
import { describe, expect, it } from "vitest";
import {
  checkMassDelete,
  computePlan,
  type LocalFileState,
  type PlanInput,
  type RemoteFileState,
  type SyncRecord,
} from "../src/planner";

function input(partial: Partial<PlanInput>): PlanInput {
  return {
    localFiles: new Map(),
    localDirs: new Set(),
    remoteFiles: new Map(),
    remoteDirs: new Set(),
    records: {},
    ...partial,
  };
}

const L = (mtimeMs: number, size = 10): LocalFileState => ({ mtimeMs, size });
const R = (mtimeMs: number, etag: string | null = "e1", size = 10): RemoteFileState => ({
  mtimeMs,
  size,
  etag,
});
const REC = (localMtime: number, remoteEtag: string | null, remoteMtime = 0, localSize = 10): SyncRecord => ({
  kind: "file",
  localMtime,
  localSize,
  remoteEtag,
  remoteMtime,
});

function types(plan: ReturnType<typeof computePlan>, path: string): string[] {
  return plan.actions.filter((a) => a.path === path).map((a) => a.type);
}

describe("file decisions", () => {
  it("in sync → no action", () => {
    const plan = computePlan(
      input({
        localFiles: new Map([["a.md", L(100)]]),
        remoteFiles: new Map([["a.md", R(500, "e1")]]),
        records: { "a.md": REC(100, "e1") },
      }),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("local edit only → upload", () => {
    const plan = computePlan(
      input({
        localFiles: new Map([["a.md", L(200)]]),
        remoteFiles: new Map([["a.md", R(500, "e1")]]),
        records: { "a.md": REC(100, "e1") },
      }),
    );
    expect(types(plan, "a.md")).toEqual(["upload"]);
  });

  it("remote edit only (etag moved) → download", () => {
    const plan = computePlan(
      input({
        localFiles: new Map([["a.md", L(100)]]),
        remoteFiles: new Map([["a.md", R(999, "e2")]]),
        records: { "a.md": REC(100, "e1") },
      }),
    );
    expect(types(plan, "a.md")).toEqual(["download"]);
  });

  it("size change counts as a local edit even with an unchanged mtime", () => {
    const plan = computePlan(
      input({
        localFiles: new Map([["a.md", L(100, 42)]]),
        remoteFiles: new Map([["a.md", R(500, "e1")]]),
        records: { "a.md": REC(100, "e1", 0, 10) },
      }),
    );
    expect(types(plan, "a.md")).toEqual(["upload"]);
  });

  it("both changed → conflict, newer wins (local newer uploads)", () => {
    const plan = computePlan(
      input({
        localFiles: new Map([["a.md", L(2000)]]),
        remoteFiles: new Map([["a.md", R(1500, "e2")]]),
        records: { "a.md": REC(100, "e1") },
      }),
    );
    expect(plan.conflicts).toEqual(["a.md"]);
    expect(types(plan, "a.md")).toEqual(["upload"]);
  });

  it("both changed → conflict, newer wins (remote newer downloads)", () => {
    const plan = computePlan(
      input({
        localFiles: new Map([["a.md", L(1000)]]),
        remoteFiles: new Map([["a.md", R(1500, "e2")]]),
        records: { "a.md": REC(100, "e1") },
      }),
    );
    expect(plan.conflicts).toEqual(["a.md"]);
    expect(types(plan, "a.md")).toEqual(["download"]);
  });

  it("new on both sides with no record → conflict, newer wins", () => {
    const plan = computePlan(
      input({
        localFiles: new Map([["a.md", L(2000)]]),
        remoteFiles: new Map([["a.md", R(1000, "e1")]]),
      }),
    );
    expect(plan.conflicts).toEqual(["a.md"]);
    expect(types(plan, "a.md")).toEqual(["upload"]);
  });

  it("new local file → upload; new remote file → download", () => {
    const plan = computePlan(
      input({
        localFiles: new Map([["new-local.md", L(100)]]),
        remoteFiles: new Map([["new-remote.md", R(100)]]),
      }),
    );
    expect(types(plan, "new-local.md")).toEqual(["upload"]);
    expect(types(plan, "new-remote.md")).toEqual(["download"]);
  });

  it("deleted remotely, local unchanged → delete local", () => {
    const plan = computePlan(
      input({
        localFiles: new Map([["a.md", L(100)]]),
        records: { "a.md": REC(100, "e1") },
      }),
    );
    expect(types(plan, "a.md")).toEqual(["deleteLocal"]);
  });

  it("deleted remotely but edited locally after → resurrect (upload)", () => {
    const plan = computePlan(
      input({
        localFiles: new Map([["a.md", L(999)]]),
        records: { "a.md": REC(100, "e1") },
      }),
    );
    expect(types(plan, "a.md")).toEqual(["upload"]);
  });

  it("deleted locally, remote unchanged → delete remote", () => {
    const plan = computePlan(
      input({
        remoteFiles: new Map([["a.md", R(500, "e1")]]),
        records: { "a.md": REC(100, "e1") },
      }),
    );
    expect(types(plan, "a.md")).toEqual(["deleteRemote"]);
  });

  it("deleted locally but changed remotely after → resurrect (download)", () => {
    const plan = computePlan(
      input({
        remoteFiles: new Map([["a.md", R(500, "e2")]]),
        records: { "a.md": REC(100, "e1") },
      }),
    );
    expect(types(plan, "a.md")).toEqual(["download"]);
  });

  it("gone from both sides → forget the record", () => {
    const plan = computePlan(input({ records: { "a.md": REC(100, "e1") } }));
    expect(plan.actions).toEqual([]);
    expect(plan.forget).toEqual(["a.md"]);
  });

  it("etag-less remote falls back to mtime:size fingerprints", () => {
    const plan = computePlan(
      input({
        localFiles: new Map([["a.md", L(100)]]),
        remoteFiles: new Map([["a.md", R(500, null)]]),
        records: { "a.md": REC(100, "500:10") },
      }),
    );
    expect(plan.actions).toEqual([]); // fingerprint matches → unchanged
  });
});

describe("mass-delete guard", () => {
  // N local files whose records say "unchanged" while the remote is empty —
  // the wiped-remote incident shape: every file plans as deleteLocal.
  function wipedRemotePlan(n: number) {
    const localFiles = new Map<string, LocalFileState>();
    const records: Record<string, SyncRecord> = {};
    for (let i = 0; i < n; i++) {
      localFiles.set(`n${i}.md`, L(100));
      records[`n${i}.md`] = REC(100, "e1");
    }
    const plan = computePlan(input({ localFiles, records }));
    return { plan, localCount: localFiles.size };
  }

  it("flags a wiped remote that would delete every local file", () => {
    const { plan, localCount } = wipedRemotePlan(65);
    expect(checkMassDelete(plan, localCount, 0, 50)).toEqual({
      side: "local",
      count: 65,
      total: 65,
    });
  });

  it("stays quiet below the minimum count even at 100% share", () => {
    const { plan, localCount } = wipedRemotePlan(5);
    expect(checkMassDelete(plan, localCount, 0, 50)).toBeNull();
  });

  it("stays quiet below the percentage threshold", () => {
    // 10 deletions out of 100 local files = 10% < 50%.
    const localFiles = new Map<string, LocalFileState>();
    const records: Record<string, SyncRecord> = {};
    for (let i = 0; i < 100; i++) localFiles.set(`keep${i}.md`, L(100));
    for (let i = 0; i < 10; i++) records[`keep${i}.md`] = REC(100, "e1");
    // keep0..keep9 have records but no remote → deleteLocal; rest are new → upload.
    const plan = computePlan(input({ localFiles, records }));
    expect(plan.actions.filter((a) => a.type === "deleteLocal")).toHaveLength(10);
    expect(checkMassDelete(plan, localFiles.size, 0, 50)).toBeNull();
  });

  it("flags remote-side mass deletion too", () => {
    const remoteFiles = new Map<string, RemoteFileState>();
    const records: Record<string, SyncRecord> = {};
    for (let i = 0; i < 12; i++) {
      remoteFiles.set(`r${i}.md`, R(500, "e1"));
      records[`r${i}.md`] = REC(100, "e1");
    }
    const plan = computePlan(input({ remoteFiles, records }));
    expect(checkMassDelete(plan, 0, remoteFiles.size, 50)).toEqual({
      side: "remote",
      count: 12,
      total: 12,
    });
  });

  it("0 disables the guard", () => {
    const { plan, localCount } = wipedRemotePlan(65);
    expect(checkMassDelete(plan, localCount, 0, 0)).toBeNull();
  });
});

describe("directory decisions", () => {
  it("new local dir → mkdir remote; new remote dir → mkdir local", () => {
    const plan = computePlan(
      input({
        localDirs: new Set(["from-local"]),
        remoteDirs: new Set(["from-remote"]),
      }),
    );
    expect(types(plan, "from-local")).toEqual(["mkdirRemote"]);
    expect(types(plan, "from-remote")).toEqual(["mkdirLocal"]);
  });

  it("dir deleted remotely (and empty locally) → rmdir local, deepest first", () => {
    const plan = computePlan(
      input({
        localDirs: new Set(["a", "a/b"]),
        records: { a: { kind: "dir" }, "a/b": { kind: "dir" } },
      }),
    );
    const rmdirs = plan.actions.filter((a) => a.type === "rmdirLocal").map((a) => a.path);
    expect(rmdirs).toEqual(["a/b", "a"]);
  });

  it("dir deletion is blocked by surviving files (resurrected content wins)", () => {
    // Dir was deleted remotely, but a local file inside it was edited since
    // the last sync → the file uploads and the dir must be recreated remotely.
    const plan = computePlan(
      input({
        localFiles: new Map([["a/keep.md", L(999)]]),
        localDirs: new Set(["a"]),
        records: { a: { kind: "dir" }, "a/keep.md": REC(100, "e1") },
      }),
    );
    expect(types(plan, "a/keep.md")).toEqual(["upload"]);
    expect(types(plan, "a")).toEqual(["mkdirRemote"]);
  });

  it("mkdirs run before transfers, rmdirs after deletes", () => {
    const plan = computePlan(
      input({
        localFiles: new Map([["d/new.md", L(1)]]),
        localDirs: new Set(["d", "gone"]),
        records: { gone: { kind: "dir" } },
      }),
    );
    const order = plan.actions.map((a) => a.type);
    expect(order.indexOf("mkdirRemote")).toBeLessThan(order.indexOf("upload"));
    expect(order.indexOf("upload")).toBeLessThan(order.indexOf("rmdirLocal"));
  });
});
