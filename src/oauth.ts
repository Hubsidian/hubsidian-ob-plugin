// OAuth 2.0 client against the hubsidian Worker itself (it IS the
// authorization server — @cloudflare/workers-oauth-provider). The plugin is a
// public client: dynamic registration (RFC 7591) with
// token_endpoint_auth_method "none", authorization code + PKCE (S256), and
// an obsidian://hubsidian-auth redirect that Obsidian routes back to us via
// registerObsidianProtocolHandler. Google login happens inside the server's
// /authorize consent flow — the plugin never sees Google credentials, only
// hubsidian's own tokens (1h access / 30d refresh by provider defaults).
//
// All HTTP goes through Obsidian's requestUrl (CORS-exempt, works on mobile).

import { requestUrl } from "obsidian";
import type { TokenSet } from "./types";

export const REDIRECT_ACTION = "hubsidian-auth";
export const REDIRECT_URI = `obsidian://${REDIRECT_ACTION}`;

interface AuthServerMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** Best-effort account display: workers-oauth-provider tokens are
 * "{userId}:{grantId}:{secret}" and hubsidian's userId is the Google email.
 * Purely cosmetic — never used for authorization decisions. */
function accountFromToken(accessToken: string): string | null {
  const first = accessToken.split(":")[0] ?? "";
  return first.includes("@") ? first : null;
}

export class OAuthManager {
  private pending: { verifier: string; state: string; clientId: string; serverUrl: string } | null =
    null;
  private refreshing: Promise<TokenSet> | null = null;

  constructor(
    private readonly getServerUrl: () => string,
    private readonly getTokens: () => TokenSet | null,
    private readonly saveTokens: (t: TokenSet | null) => Promise<void>,
  ) {}

  get connected(): boolean {
    const t = this.getTokens();
    return !!t && normalizeServerUrl(t.serverUrl) === normalizeServerUrl(this.getServerUrl());
  }

  get account(): string | null {
    return this.getTokens()?.account ?? null;
  }

  private async discover(server: string): Promise<AuthServerMeta> {
    const res = await requestUrl({
      url: `${server}/.well-known/oauth-authorization-server`,
      throw: false,
    });
    if (res.status !== 200) {
      throw new Error(`OAuth discovery failed (${res.status}) — is the server URL correct?`);
    }
    return res.json as AuthServerMeta;
  }

  /** Register a fresh public client and return the browser URL to open. The
   * verifier/state stay in memory until the obsidian:// callback arrives. */
  async beginLogin(): Promise<string> {
    const server = normalizeServerUrl(this.getServerUrl());
    if (!server) throw new Error("Set the server URL first.");
    const meta = await this.discover(server);

    const reg = await requestUrl({
      url: meta.registration_endpoint,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        client_name: "Hubsidian Sync (Obsidian plugin)",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
      throw: false,
    });
    if (reg.status !== 201 && reg.status !== 200) {
      throw new Error(`Client registration failed (${reg.status}).`);
    }
    const clientId = (reg.json as { client_id: string }).client_id;

    const { verifier, challenge } = await pkcePair();
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    this.pending = { verifier, state, clientId, serverUrl: server };

    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /** obsidian://hubsidian-auth?code=…&state=… lands here. */
  async completeLogin(params: Record<string, string>): Promise<TokenSet> {
    const pending = this.pending;
    if (!pending) throw new Error("No sign-in in progress. Start again from the settings tab.");
    if (params.error) throw new Error(`Authorization failed: ${params.error}`);
    if (!params.code) throw new Error("Authorization response carried no code.");
    if (params.state !== pending.state) throw new Error("State mismatch — sign in again.");
    this.pending = null;

    const tokens = await this.exchange(pending.serverUrl, {
      grant_type: "authorization_code",
      code: params.code,
      client_id: pending.clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier,
    }, pending.clientId);
    await this.saveTokens(tokens);
    return tokens;
  }

  /** Valid Bearer token; refreshes ahead of expiry (single-flight). */
  async getAccessToken(force = false): Promise<string> {
    const t = this.getTokens();
    if (!t) throw new Error("Not connected — sign in from the Hubsidian Sync settings.");
    if (!force && Date.now() < t.expiresAt - 60_000) return t.accessToken;
    if (!t.refreshToken) throw new Error("Session expired and no refresh token — sign in again.");
    this.refreshing ??= this.refresh(t).finally(() => {
      this.refreshing = null;
    });
    return (await this.refreshing).accessToken;
  }

  private async refresh(t: TokenSet): Promise<TokenSet> {
    const tokens = await this.exchange(normalizeServerUrl(t.serverUrl), {
      grant_type: "refresh_token",
      refresh_token: t.refreshToken ?? "",
      client_id: t.clientId,
    }, t.clientId);
    // The provider rotates refresh tokens; fall back to the old one if a
    // response ever omits it.
    if (!tokens.refreshToken) tokens.refreshToken = t.refreshToken;
    await this.saveTokens(tokens);
    return tokens;
  }

  private async exchange(
    server: string,
    form: Record<string, string>,
    clientId: string,
  ): Promise<TokenSet> {
    const res = await requestUrl({
      url: `${server}/token`,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams(form).toString(),
      throw: false,
    });
    if (res.status !== 200) {
      if (form.grant_type === "refresh_token" && (res.status === 400 || res.status === 401)) {
        await this.saveTokens(null); // dead grant — force a fresh sign-in
        throw new Error("Session expired — sign in again from the Hubsidian Sync settings.");
      }
      throw new Error(`Token request failed (${res.status}).`);
    }
    const body = res.json as TokenResponse;
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      clientId,
      serverUrl: server,
      account: accountFromToken(body.access_token),
    };
  }

  async logout(): Promise<void> {
    this.pending = null;
    await this.saveTokens(null);
  }
}
