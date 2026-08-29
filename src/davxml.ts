// Minimal PROPFIND multistatus parser for hubsidian's /dav responses.
// Pure string/regex based (no DOMParser) so it runs identically in the
// Obsidian renderer, the mobile webview, and node-based tests. Tolerant of
// any namespace prefix, but only guarantees the property set hubsidian's
// src/dav/xml.ts actually emits (displayname, resourcetype, getlastmodified,
// getcontentlength, getcontenttype, getetag).

export interface RemoteEntry {
  /** Path relative to the vault root ("" = the collection itself). */
  path: string;
  isDir: boolean;
  size: number;
  /** Server timestamp (upload time) in ms; 0 when the server sent none. */
  mtimeMs: number;
  /** Unquoted etag, or null when the server sent none. */
  etag: string | null;
}

const RESPONSE_RE = /<(?:[A-Za-z0-9_.-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?response>/gi;

function tagText(block: string, tag: string): string | null {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`,
    "i",
  );
  const m = re.exec(block);
  return m ? m[1] : null;
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Decode a percent-encoded URL path segment-by-segment (slashes literal). */
function decodePath(p: string): string | null {
  try {
    return p
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .join("/");
  } catch {
    return null;
  }
}

/**
 * Parse a 207 multistatus body into vault-relative entries.
 *
 * `hrefPrefix` is the DECODED URL path of the vault's WebDAV root, e.g.
 * "/dav/My Vault". Entries whose href does not live under it are skipped
 * (defensive — hubsidian never emits them).
 */
export function parseMultistatus(xml: string, hrefPrefix: string): RemoteEntry[] {
  const prefix = hrefPrefix.replace(/\/+$/, "");
  const out: RemoteEntry[] = [];
  for (const block of xml.match(RESPONSE_RE) ?? []) {
    const rawHref = tagText(block, "href");
    if (rawHref === null) continue;
    let href = xmlUnescape(rawHref.trim());
    // Absolute URLs appear from some servers; keep only the path.
    if (/^https?:\/\//i.test(href)) {
      const slash = href.indexOf("/", href.indexOf("://") + 3);
      href = slash === -1 ? "/" : href.slice(slash);
    }
    const decoded = decodePath(href);
    if (decoded === null) continue;

    const isDir = new RegExp("<(?:[A-Za-z0-9_.-]+:)?collection\\b", "i").test(block);
    let rel: string;
    if (decoded === prefix || decoded === `${prefix}/`) {
      rel = "";
    } else if (decoded.startsWith(`${prefix}/`)) {
      rel = decoded.slice(prefix.length + 1).replace(/\/+$/, "");
    } else {
      continue;
    }

    const lm = tagText(block, "getlastmodified");
    const mtimeMs = lm ? Date.parse(xmlUnescape(lm.trim())) || 0 : 0;
    const len = tagText(block, "getcontentlength");
    const size = len ? Number.parseInt(len.trim(), 10) || 0 : 0;
    const rawEtag = tagText(block, "getetag");
    const etag = rawEtag
      ? xmlUnescape(rawEtag.trim())
          .replace(/^W\//i, "")
          .replace(/^"|"$/g, "") || null
      : null;

    out.push({ path: rel, isDir, size, mtimeMs, etag });
  }
  return out;
}
