import { Notice, Plugin } from "obsidian";
import { OAuthManager, REDIRECT_ACTION } from "./oauth";
import { DavClient } from "./webdav";
import { SyncEngine, type SyncSummary } from "./sync";
import { HubsidianSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type PluginData, type TokenSet } from "./types";
import type { SyncRecord } from "./planner";

const DEFAULT_DATA: PluginData = {
  settings: DEFAULT_SETTINGS,
  tokens: null,
  syncRecords: {},
  lastSyncAt: null,
};

export default class HubsidianSyncPlugin extends Plugin {
  data: PluginData = DEFAULT_DATA;
  oauth!: OAuthManager;
  dav!: DavClient;
  engine!: SyncEngine;
  private statusBar!: HTMLElement;
  private autoSyncHandle: number | null = null;

  async onload(): Promise<void> {
    const stored = (await this.loadData()) as Partial<PluginData> | null;
    this.data = {
      ...DEFAULT_DATA,
      ...stored,
      settings: { ...DEFAULT_SETTINGS, ...(stored?.settings ?? {}) },
    };
    // First run: default the remote vault name to this vault's name.
    if (!this.data.settings.vaultName) {
      this.data.settings.vaultName = this.app.vault.getName();
      await this.persist();
    }

    this.oauth = new OAuthManager(
      () => this.data.settings.serverUrl,
      () => this.data.tokens,
      async (t: TokenSet | null) => {
        this.data.tokens = t;
        await this.persist();
      },
    );
    this.dav = new DavClient(
      this.oauth,
      () => this.data.settings.serverUrl,
      () => this.data.settings.vaultName,
    );
    this.engine = new SyncEngine(
      this.app,
      this.dav,
      () => this.data.settings,
      () => this.data.syncRecords,
      async (records: Record<string, SyncRecord>) => {
        this.data.syncRecords = records;
        this.data.lastSyncAt = Date.now();
        await this.persist();
      },
      (text) => this.setStatus(`hubsidian: ${text}`),
    );

    // The browser lands on obsidian://hubsidian-auth?code=…&state=… after
    // the server-side Google consent finishes.
    this.registerObsidianProtocolHandler(REDIRECT_ACTION, (params) => {
      void this.oauth
        .completeLogin(params as unknown as Record<string, string>)
        .then((t) => {
          new Notice(`hubsidian: connected${t.account ? ` as ${t.account}` : ""}`);
        })
        .catch((e: unknown) => {
          new Notice(`hubsidian: sign-in failed — ${e instanceof Error ? e.message : String(e)}`);
        });
    });

    this.statusBar = this.addStatusBarItem();
    this.setStatus("hubsidian: idle");

    this.addRibbonIcon("refresh-cw", "Hubsidian: sync now", () => void this.syncNow());
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow(),
    });
    this.addSettingTab(new HubsidianSettingTab(this.app, this));

    this.applyAutoSync();
    if (this.data.settings.syncOnStart) {
      // Give the vault index a moment to settle after startup.
      window.setTimeout(() => void this.syncNow(true), 3000);
    }
  }

  onunload(): void {
    this.clearAutoSync();
  }

  async persist(): Promise<void> {
    await this.saveData(this.data);
  }

  setStatus(text: string): void {
    this.statusBar?.setText(text);
  }

  applyAutoSync(): void {
    this.clearAutoSync();
    const minutes = this.data.settings.autoSyncMinutes;
    if (minutes > 0) {
      this.autoSyncHandle = window.setInterval(
        () => void this.syncNow(true),
        minutes * 60_000,
      );
      this.registerInterval(this.autoSyncHandle);
    }
  }

  private clearAutoSync(): void {
    if (this.autoSyncHandle !== null) {
      window.clearInterval(this.autoSyncHandle);
      this.autoSyncHandle = null;
    }
  }

  async syncNow(quiet = false): Promise<void> {
    if (this.engine.isRunning) {
      if (!quiet) new Notice("hubsidian: sync already running");
      return;
    }
    if (!this.data.settings.serverUrl || !this.data.settings.vaultName) {
      if (!quiet) new Notice("hubsidian: set the server URL and vault name in settings first");
      return;
    }
    if (!this.oauth.connected) {
      if (!quiet) new Notice("hubsidian: not connected — sign in from the plugin settings");
      return;
    }
    this.setStatus("hubsidian: syncing…");
    try {
      const summary = await this.engine.run();
      this.setStatus(`hubsidian: ✓ ${new Date().toLocaleTimeString()}`);
      this.report(summary, quiet);
    } catch (e: unknown) {
      this.setStatus("hubsidian: sync failed");
      new Notice(`hubsidian: sync failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private report(s: SyncSummary, quiet: boolean): void {
    const changes = s.uploaded + s.downloaded + s.deletedLocal + s.deletedRemote;
    if (s.errors.length > 0) {
      console.error("[hubsidian] sync errors:", s.errors);
      new Notice(`hubsidian: sync finished with ${s.errors.length} error(s) — see console`);
      return;
    }
    if (s.conflicts.length > 0) {
      console.warn("[hubsidian] conflicts resolved newer-wins:", s.conflicts);
    }
    if (!quiet || changes > 0) {
      new Notice(
        changes === 0
          ? "hubsidian: already in sync"
          : `hubsidian: ↑${s.uploaded} ↓${s.downloaded}` +
            (s.deletedLocal + s.deletedRemote > 0 ? ` 🗑${s.deletedLocal + s.deletedRemote}` : "") +
            (s.conflicts.length > 0 ? ` (${s.conflicts.length} conflict(s), newer won)` : ""),
      );
    }
  }

  /** Forget the sync snapshot: the next run re-baselines (no deletions are
   * propagated; extra copies win over missing ones). */
  async resetSyncState(): Promise<void> {
    this.data.syncRecords = {};
    this.data.lastSyncAt = null;
    await this.persist();
  }
}
