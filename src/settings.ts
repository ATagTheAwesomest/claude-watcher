import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import type ClaudeWatcherPlugin from "./main";
import type { TaskSize } from "./shared/types";

export interface WatcherSettings {
  /** Address of the watcher server, such as https://watcher.example.com. */
  serverUrl: string;
  /** The server's API key (WATCHER_API_KEY). */
  apiKey: string;
  /** How often to look for new approval requests and changes, in seconds. */
  pollSeconds: number;
  /** Task size for new messages unless changed in the chat. */
  defaultTask: TaskSize;
}

export const DEFAULT_SETTINGS: WatcherSettings = {
  serverUrl: "http://localhost:9776",
  apiKey: "",
  pollSeconds: 10,
  defaultTask: "simple",
};

export class WatcherSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ClaudeWatcherPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const { settings } = this.plugin;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Server address")
      .setDesc("Where the watcher server is reachable, for example https://watcher.example.com.")
      .addText((text) =>
        text
          .setPlaceholder("https://watcher.example.com")
          .setValue(settings.serverUrl)
          .onChange(async (value) => {
            settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("The server's WATCHER_API_KEY. It is stored in this vault's plugin folder.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Paste the key")
          .setValue(settings.apiKey)
          .onChange(async (value) => {
            settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Check every")
      .setDesc("Seconds between checks for new approval requests and edits.")
      .addSlider((slider) =>
        slider
          .setLimits(5, 120, 5)
          .setValue(settings.pollSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.pollSeconds = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Default task size")
      .setDesc("Simple tasks run on the server's smaller model, complex tasks on the larger one.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ simple: "Simple", complex: "Complex" })
          .setValue(settings.defaultTask)
          .onChange(async (value) => {
            settings.defaultTask = value as TaskSize;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Test the connection").addButton((button) =>
      button.setButtonText("Test").onClick(async () => {
        try {
          await this.plugin.client.pendingApprovals();
          new Notice("Connected to the watcher server.");
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        }
      }),
    );
  }
}
