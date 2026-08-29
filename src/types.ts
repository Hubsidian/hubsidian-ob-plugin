import type { SyncRecord } from "./planner";

export interface HubsidianSettings {
  /** Origin of the hubsidian Worker, e.g. https://hub.example.com (no path). */
  serverUrl: string;
  /** Remote vault name = first /dav path segment = {tenant}/{user}/{VAULT}/. */
  vaultName: string;
  syncOnStart: boolean;
  /** 0 disables the interval. */
  autoSyncMinutes: number;
  /** Vault-relative folder prefixes to leave out of sync (besides dot-dirs). */
  excludeFolders: string[];
  /** Abort sync when it would delete ≥10 files AND at least this share (%)
   * of one side's files. 0 disables the guard. */
  massDeleteThresholdPercent: number;
}

export const DEFAULT_SETTINGS: HubsidianSettings = {
  serverUrl: "",
  vaultName: "",
  syncOnStart: false,
  autoSyncMinutes: 0,
  excludeFolders: [],
  massDeleteThresholdPercent: 50,
};

/** OAuth state persisted in the plugin's data.json (device-local). */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms after which accessToken must be refreshed. */
  expiresAt: number;
  /** Dynamic-registration client id, bound to serverUrl. */
  clientId: string;
  serverUrl: string;
  /** Best-effort display identity (from the token's userId part). */
  account: string | null;
}

export interface PluginData {
  settings: HubsidianSettings;
  tokens: TokenSet | null;
  /** Post-sync snapshot per path — the planner's third input. */
  syncRecords: Record<string, SyncRecord>;
  lastSyncAt: number | null;
}
