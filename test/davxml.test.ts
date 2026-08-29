// parseMultistatus against the exact XML shape hubsidian's src/dav/xml.ts
// renders (plus a few tolerance cases: absolute-URL hrefs, W/ etags, other
// namespace prefixes).
import { describe, expect, it } from "vitest";
import { parseMultistatus } from "../src/davxml";

const PREFIX = "/dav/My Vault";

function response(opts: {
  href: string;
  dir?: boolean;
  size?: number;
  mtime?: string;
  etag?: string;
}): string {
  return (
    "<D:response>" +
    `<D:href>${opts.href}</D:href>` +
    "<D:propstat><D:prop>" +
    (opts.dir ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>") +
    (opts.mtime ? `<D:getlastmodified>${opts.mtime}</D:getlastmodified>` : "") +
    (opts.size !== undefined ? `<D:getcontentlength>${opts.size}</D:getcontentlength>` : "") +
    (opts.etag ? `<D:getetag>${opts.etag}</D:getetag>` : "") +
    "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>" +
    "</D:response>"
  );
}

function multistatus(...responses: string[]): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' +
    responses.join("") +
    "</D:multistatus>"
  );
}

describe("parseMultistatus", () => {
  it("parses files with size, mtime, and unquoted etag", () => {
    const xml = multistatus(
      response({
        href: "/dav/My%20Vault/notes/a.md",
        size: 42,
        mtime: "Fri, 28 Aug 2026 10:00:00 GMT",
        etag: "&quot;abc123&quot;",
      }),
    );
    const [entry] = parseMultistatus(xml, PREFIX);
    expect(entry).toEqual({
      path: "notes/a.md",
      isDir: false,
      size: 42,
      mtimeMs: Date.parse("Fri, 28 Aug 2026 10:00:00 GMT"),
      etag: "abc123",
    });
  });

  it("marks collections and strips their trailing slash", () => {
    const xml = multistatus(
      response({ href: "/dav/My%20Vault/", dir: true }),
      response({ href: "/dav/My%20Vault/sub/", dir: true }),
    );
    const entries = parseMultistatus(xml, PREFIX);
    expect(entries.map((e) => [e.path, e.isDir])).toEqual([
      ["", true],
      ["sub", true],
    ]);
  });

  it("decodes percent-encoded non-ASCII hrefs", () => {
    const xml = multistatus(
      response({ href: `/dav/My%20Vault/${encodeURIComponent("メモ")}/${encodeURIComponent("日誌.md")}`, size: 3 }),
    );
    expect(parseMultistatus(xml, PREFIX)[0].path).toBe("メモ/日誌.md");
  });

  it("accepts absolute-URL hrefs and foreign namespace prefixes", () => {
    const xml =
      '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' +
      "<d:response><d:href>https://hub.example.com/dav/My%20Vault/x.md</d:href>" +
      "<d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1</d:getcontentlength>" +
      "<d:getetag>W/&quot;weak&quot;</d:getetag></d:prop></d:propstat></d:response></d:multistatus>";
    const [entry] = parseMultistatus(xml, PREFIX);
    expect(entry.path).toBe("x.md");
    expect(entry.etag).toBe("weak");
  });

  it("skips entries outside the vault prefix", () => {
    const xml = multistatus(response({ href: "/dav/Other/leak.md", size: 1 }));
    expect(parseMultistatus(xml, PREFIX)).toEqual([]);
  });

  it("unescapes XML entities in hrefs (ampersand folder)", () => {
    const xml = multistatus(response({ href: "/dav/My%20Vault/a%20&amp;%20b.md", size: 1 }));
    expect(parseMultistatus(xml, PREFIX)[0].path).toBe("a & b.md");
  });
});
