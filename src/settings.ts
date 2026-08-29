import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type HubsidianSyncPlugin from "./main";
import { normalizeServerUrl } from "./oauth";

export class HubsidianSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: HubsidianSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Your hubsidian Worker origin, e.g. https://hub.example.com")
      .addText((text) =>
        text
          .setPlaceholder("https://hub.example.com")
          .setValue(this.plugin.data.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.data.settings.serverUrl = normalizeServerUrl(value);
            await this.plugin.persist();
          }),
      );

    new Setting(containerEl)
      .setName("Remote vault name")
      .setDesc(
        "First path segment under /dav — your notes live at {tenant}/{account}/{this name}/ in R2. " +
          "Defaults to this vault's name. Changing it re-baselines sync.",
      )
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(this.plugin.data.settings.vaultName)
          .onChange(async (value) => {
            const next = value.trim();
            if (next !== this.plugin.data.settings.vaultName) {
              this.plugin.data.settings.vaultName = next;
              // A different remote vault invalidates every snapshot record.
              await this.plugin.resetSyncState();
            }
            await this.plugin.persist();
          }),
      );

    const account = this.plugin.oauth.account;
    new Setting(containerEl)
      .setName("Account")
      .setDesc(
        this.plugin.oauth.connected
          ? `Connected${account ? ` as ${account}` : ""}. Sign-in uses the server's Google login.`
          : "Not connected. Sign in opens your browser for the server's Google login, then returns here.",
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.plugin.oauth.connected ? "Sign out" : "Sign in")
          .setCta()
          .onClick(async () => {
            try {
              if (this.plugin.oauth.connected) {
                await this.plugin.oauth.logout();
                new Notice("hubsidian: signed out");
              } else {
                const url = await this.plugin.oauth.beginLogin();
                window.open(url);
                new Notice("hubsidian: finish signing in in your browser");
              }
            } catch (e: unknown) {
              new Notice(`hubsidian: ${e instanceof Error ? e.message : String(e)}`);
            }
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run a sync a few seconds after Obsidian opens this vault.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.data.settings.syncOnStart).onChange(async (value) => {
          this.plugin.data.settings.syncOnStart = value;
          await this.plugin.persist();
        }),
      );

    new Setting(containerEl)
      .setName("Auto-sync interval (minutes)")
      .setDesc("0 disables periodic sync.")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.data.settings.autoSyncMinutes))
          .onChange(async (value) => {
            const minutes = Math.max(0, Number.parseInt(value, 10) || 0);
            this.plugin.data.settings.autoSyncMinutes = minutes;
            await this.plugin.persist();
            this.plugin.applyAutoSync();
          }),
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc(
        "Comma-separated vault folders to keep out of sync. Dot-folders (.obsidian, .git, …) are always excluded.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Private, Daily/Scratch")
          .setValue(this.plugin.data.settings.excludeFolders.join(", "))
          .onChange(async (value) => {
            this.plugin.data.settings.excludeFolders = value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.persist();
          }),
      );

    new Setting(containerEl)
      .setName("Mass-delete guard (%)")
      .setDesc(
        "Abort sync when it would delete at least 10 files AND more than this share of one side's " +
          "files (e.g. after a wiped remote). 0 disables. Deleting that much on purpose? Prefer " +
          "Reset sync state (re-baselines without deletions).",
      )
      .addText((text) =>
        text
          .setPlaceholder("50")
          .setValue(String(this.plugin.data.settings.massDeleteThresholdPercent))
          .onChange(async (value) => {
            const pct = Math.min(100, Math.max(0, Number.parseInt(value, 10) || 0));
            this.plugin.data.settings.massDeleteThresholdPercent = pct;
            await this.plugin.persist();
          }),
      );

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc(
        this.plugin.data.lastSyncAt
          ? `Last synced ${new Date(this.plugin.data.lastSyncAt).toLocaleString()}`
          : "Never synced from this device.",
      )
      .addButton((btn) =>
        btn.setButtonText("Sync now").onClick(() => void this.plugin.syncNow()),
      );

    new Setting(containerEl)
      .setName("Reset sync state")
      .setDesc(
        "Forget what was synced before. The next run re-baselines: nothing is deleted, files existing " +
          "on only one side are copied to the other, and same-path differences resolve newer-wins.",
      )
      .addButton((btn) =>
        btn
          .setButtonText("Reset")
          .setWarning()
          .onClick(async () => {
            await this.plugin.resetSyncState();
            new Notice("hubsidian: sync state cleared");
            this.display();
          }),
      );
  }
}
