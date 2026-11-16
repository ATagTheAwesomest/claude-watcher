import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import type ClaudeWatcherPlugin from "./main";
import { SYNTAX_EXAMPLES } from "./instructions";
import type { InstructionSyntax, SearchMode, TaskSize } from "./shared/types";

export interface WatcherSettings {
  /** Address of the watcher server, such as https://watcher.example.com. */
  serverUrl: string;
  /** The server's API key (WATCHER_API_KEY). */
  apiKey: string;
  /** How often to look for new approval requests and changes, in seconds. */
  pollSeconds: number;
  /** Task size for new messages unless changed in the chat. */
  defaultTask: TaskSize;
  /** How instructions are written in notes, unless the server reports its own. */
  instructionSyntax: InstructionSyntax;
  /** Show the "Lines 12-18 +" button under a selection in a note. */
  selectionButton: boolean;
  /** Attach the open note to chat messages when Claude can already read it. */
  includeOpenNote: boolean;
}

export const DEFAULT_SETTINGS: WatcherSettings = {
  serverUrl: "http://localhost:9776",
  apiKey: "",
  pollSeconds: 10,
  defaultTask: "simple",
  instructionSyntax: "angle",
  selectionButton: true,
  includeOpenNote: true,
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

    const syntaxSetting = new Setting(containerEl).setName("Instruction syntax");
    this.renderSyntax(syntaxSetting);

    void this.showServerSettings(containerEl.createDiv(), syntaxSetting);

    new Setting(containerEl)
      .setName("Selection button")
      .setDesc("Show a button under selected text in a note that adds those lines to the chat.")
      .addToggle((toggle) =>
        toggle.setValue(settings.selectionButton).onChange(async (value) => {
          settings.selectionButton = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Include the open note")
      .setDesc(
        "Attach the note you are viewing to chat messages when it is already shared with Claude through % or %%. Private notes are never attached on their own.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.includeOpenNote).onChange(async (value) => {
          settings.includeOpenNote = value;
          await this.plugin.saveSettings();
          this.plugin.context.refresh();
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

  /** Shows the search settings the server uses. They are changed on the server, not here. */
  private renderSyntax(setting: Setting): void {
    const { plugin } = this;
    const server = plugin.serverSyntax;
    setting.controlEl.empty();
    setting.setDesc(
      server
        ? `Following the server, which reads ${SYNTAX_EXAMPLES[server]}. Change it with WATCHER_INSTRUCTION_SYNTAX on the server.`
        : "How instructions are written in %% notes. Angle brackets also accept the older [c: ...].",
    );
    setting.addDropdown((dropdown) =>
      dropdown
        .addOptions({
          angle: `Angle brackets ${SYNTAX_EXAMPLES.angle}`,
          square: `Square brackets ${SYNTAX_EXAMPLES.square}`,
        })
        .setValue(server ?? plugin.settings.instructionSyntax)
        .setDisabled(server !== undefined)
        .onChange(async (value) => {
          plugin.settings.instructionSyntax = value as InstructionSyntax;
          await plugin.saveSettings();
        }),
    );
  }

  private async showServerSettings(el: HTMLElement, syntaxSetting: Setting): Promise<void> {
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
      const syntax = settings.instructions?.syntax;
      this.plugin.setServerSyntax(syntax === "angle" || syntax === "square" ? syntax : undefined);
      this.renderSyntax(syntaxSetting);
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
