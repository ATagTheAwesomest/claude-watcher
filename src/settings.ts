import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import type ClaudeWatcherPlugin from "./main";
import type { SearchMode, TaskSize } from "./shared/types";

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

    void this.showServerSettings(containerEl.createDiv());

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

  /** Shows the search settings the server uses. They are changed on the server, not here. */
  private async showServerSettings(el: HTMLElement): Promise<void> {
    new Setting(el).setName("Search on the server").setHeading();
    const info = el.createDiv({ cls: "setting-item-description" });
    if (!this.plugin.client.configured) {
      info.setText("Fill in the server address and API key to see them.");
      return;
    }
    info.setText("Loading…");
    try {
      const settings = await this.plugin.client.serverSettings();
      if (!settings) {
        info.setText("This server does not report its search settings. Update it to see them.");
        return;
      }
      info.empty();
      const { mode, maxSuggestions } = settings.search;
      new Setting(el)
        .setName("Search mode")
        .setDesc(SEARCH_MODES[mode] ?? mode)
        .addText((text) => text.setValue(mode).setDisabled(true));
      new Setting(el)
        .setName("Suggestions per request")
        .setDesc("The most ranges offered for approval when Claude asks for more.")
        .addText((text) => text.setValue(String(maxSuggestions)).setDisabled(true));
      el.createDiv({
        cls: "setting-item-description",
        text: "These are set in the server's configuration and shown here for reference.",
      });
    } catch (error) {
      info.setText(error instanceof Error ? error.message : String(error));
    }
  }
}

const SEARCH_MODES: Record<SearchMode, string> = {
  claude: "Claude chooses the search terms and the server searches the vault for them.",
  keyword: "The server searches the vault for the words of Claude's request.",
  ollama: "A local model chooses the search terms and trims the matches.",
};
