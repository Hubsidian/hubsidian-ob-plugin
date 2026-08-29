// WebDAV client for hubsidian's /dav endpoint, over Obsidian's requestUrl
// (CORS-exempt on desktop and mobile). Bearer auth with a one-shot
// refresh-and-retry on 401. Speaks exactly the subset the server implements:
// PROPFIND Depth 1 (walking, since the server rejects Depth infinity),
// GET/PUT/DELETE/MKCOL.

import { requestUrl, type RequestUrlResponse } from "obsidian";
import { parseMultistatus, type RemoteEntry } from "./davxml";
import type { RemoteFileState } from "./planner";
import type { OAuthManager } from "./oauth";

export interface RemoteListing {
  files: Map<string, RemoteFileState>;
  dirs: Set<string>;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function header(res: RequestUrlResponse, name: string): string | null {
  // Obsidian header casing differs per platform; check both spellings.
  return res.headers[name] ?? res.headers[name.toLowerCase()] ?? res.headers[name.toUpperCase()] ?? null;
}

export class DavClient {
  constructor(
    private readonly auth: OAuthManager,
    private readonly getServerUrl: () => string,
    private readonly getVaultName: () => string,
  ) {}

  /** Decoded prefix the server puts in PROPFIND hrefs: /dav/<vault>. */
  get hrefPrefix(): string {
    return `/dav/${this.getVaultName()}`;
  }

  private url(path: string, dir: boolean): string {
    const base = `${this.getServerUrl().replace(/\/+$/, "")}/dav/${encodeURIComponent(this.getVaultName())}`;
    if (path === "") return `${base}/`;
    return `${base}/${encodePath(path)}${dir ? "/" : ""}`;
  }

  private async request(
    method: string,
    path: string,
    opts: { dir?: boolean; headers?: Record<string, string>; body?: string | ArrayBuffer } = {},
  ): Promise<RequestUrlResponse> {
    const send = async (token: string) =>
      requestUrl({
        url: this.url(path, opts.dir ?? false),
        method,
        headers: { ...(opts.headers ?? {}), authorization: `Bearer ${token}` },
        body: opts.body,
        throw: false,
      });
    let res = await send(await this.auth.getAccessToken());
    if (res.status === 401) {
      // Access token aged out mid-sync — refresh once and retry.
      res = await send(await this.auth.getAccessToken(true));
    }
    return res;
  }

  private fail(op: string, path: string, res: RequestUrlResponse): never {
    throw new Error(`${op} ${path || "/"} failed (${res.status})`);
  }

  async propfind(dirPath: string): Promise<RemoteEntry[]> {
    const res = await this.request("PROPFIND", dirPath, { dir: true, headers: { depth: "1" } });
    if (res.status !== 207) this.fail("PROPFIND", dirPath, res);
    return parseMultistatus(res.text, this.hrefPrefix);
  }

  /** Whole remote vault: breadth-first Depth-1 walk. `skip` filters dirs the
   * sync excludes so their subtrees are never even listed. Entry paths from
   * parseMultistatus are already vault-root-relative (the server's hrefs are
   * /dav/<vault>/<full path>), so no per-level joining happens here. */
  async listAll(skip: (dirPath: string) => boolean): Promise<RemoteListing> {
    const files = new Map<string, RemoteFileState>();
    const dirs = new Set<string>();
    const queue: string[] = [""];
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      for (const entry of await this.propfind(dir)) {
        const path = entry.path;
        if (path === "" || path === dir) continue; // the collection itself
        if (skip(path)) continue;
        if (entry.isDir) {
          dirs.add(path);
          queue.push(path);
        } else {
          files.set(path, { mtimeMs: entry.mtimeMs, size: entry.size, etag: entry.etag });
        }
      }
    }
    return { files, dirs };
  }

  async download(path: string): Promise<ArrayBuffer> {
    const res = await this.request("GET", path);
    if (res.status !== 200) this.fail("GET", path, res);
    return res.arrayBuffer;
  }

  /** PUT a file; returns the new etag (the planner's remote fingerprint). */
  async upload(path: string, data: ArrayBuffer, contentType: string): Promise<string | null> {
    const res = await this.request("PUT", path, {
      body: data,
      headers: { "content-type": contentType },
    });
    if (res.status !== 201 && res.status !== 204) this.fail("PUT", path, res);
    const etag = header(res, "etag");
    return etag ? etag.replace(/^W\//i, "").replace(/^"|"$/g, "") : null;
  }

  /** Fallback fingerprint fetch when a PUT response carried no etag. */
  async stat(path: string): Promise<RemoteFileState | null> {
    const res = await this.request("PROPFIND", path, { headers: { depth: "0" } });
    if (res.status !== 207) return null;
    const entry = parseMultistatus(res.text, this.hrefPrefix).find((e) => !e.isDir);
    return entry ? { mtimeMs: entry.mtimeMs, size: entry.size, etag: entry.etag } : null;
  }

  async mkcol(path: string): Promise<void> {
    const res = await this.request("MKCOL", path);
    // 405 = already exists — fine, MKCOL is only advisory for empty dirs.
    if (res.status !== 201 && res.status !== 405) this.fail("MKCOL", path, res);
  }

  async remove(path: string, dir: boolean): Promise<void> {
    const res = await this.request("DELETE", path, { dir });
    // 404 = already gone (e.g. deleted with its parent dir) — idempotent.
    if (res.status !== 204 && res.status !== 404) this.fail("DELETE", path, res);
  }
}
