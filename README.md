# Hubsidian Sync (Obsidian plugin)

Syncs an Obsidian vault with a [hubsidian](https://github.com/Hubsidian/hubsidian)
Worker over its `/dav` WebDAV endpoint. Authentication is the server's own
OAuth: the plugin registers itself as an OAuth client (RFC 7591), walks the
authorization-code + PKCE flow in your browser (where the server runs its
Google login + email allowlist), and syncs with the resulting Bearer tokens —
the exact same tokens MCP clients use. No app passwords, nothing to paste.

## How sync works

- Two-way sync with a per-device snapshot (stored in the plugin's
  `data.json`): each run compares local and remote against the last-synced
  state, so edits, creations, and deletions propagate in both directions.
- Conflicts (changed on both sides since the last sync) resolve **newer
  wins** (file mtime vs. server upload time); resolved paths are listed in
  the console.
- Remote listing walks `PROPFIND Depth: 1`; transfers run a few at a time.
- Dot-folders (`.obsidian`, `.git`, `.trash`, …) never sync — the plugin's
  own tokens live under `.obsidian` and must stay device-local. Additional
  folders can be excluded in settings.
- **No sync path deletes local data outright**: deletions go through
  Obsidian's trash (falling back to the vault-local `.trash/`), and the
  losing side of a conflict is parked in `.trash/` before it is overwritten
  (locally) or replaced (remotely).
- **Mass-delete guard**: a sync that would delete ≥10 files and more than a
  configurable share (default 50%) of one side aborts instead — the shape a
  wiped or renamed remote produces. Re-baseline intentional wipes with
  *Reset sync state* (propagates no deletions), or raise/disable the guard.

## Install (manual, pre-release)

```bash
npm install
npm run build   # tsc --noEmit + esbuild; emits main.js
```

Copy `main.js` and `manifest.json` into
`<vault>/.obsidian/plugins/hubsidian-sync/`, then enable the plugin in
Obsidian's Community-plugins pane.

## Setup

1. Settings → Hubsidian Sync → set **Server URL** (e.g. `https://hub.example.com`).
2. Check **Remote vault name** — defaults to this vault's name; it becomes the
   first `/dav` path segment (`{tenant}/{account}/{vault}/…` in R2).
3. **Sign in** → the browser opens the server's consent + Google login → the
   browser redirects to `obsidian://hubsidian-auth` and Obsidian finishes the
   connection. (Keep this vault's window focused when the redirect fires.)
4. **Sync now** (ribbon icon, command palette, or the settings button).

Tokens auto-refresh (1 h access / 30 d refresh by server defaults). When the
refresh token finally ages out, the plugin asks you to sign in again.
