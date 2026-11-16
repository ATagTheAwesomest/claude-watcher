// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { CHAT_VIEW } from "../src/chatView";
import ClaudeWatcherPlugin from "../src/main";
import { App, Platform, TFile } from "./support/obsidian";

let app: App;
let plugin: ClaudeWatcherPlugin;

const chatLeaves = () => app.workspace.getLeavesOfType(CHAT_VIEW);

beforeEach(async () => {
  Platform.isPhone = false;
  app = new App();
  app.vault.files = [new TFile("Plan %.md")];
  plugin = new (ClaudeWatcherPlugin as unknown as new (app: App) => ClaudeWatcherPlugin)(app);
  await plugin.onload();
  plugin.refresh = async () => {};
  plugin.contextApprovals.add = async () => {};
});

describe("whether the chat is open", () => {
  it("is false with no chat panel, and true once it is shown", async () => {
    expect(plugin.chatIsOpen()).toBe(false);
    await plugin.showView(CHAT_VIEW);
    expect(plugin.chatIsOpen()).toBe(true);
  });

  it("is false on a desktop while the sidebar holding the chat is collapsed", async () => {
    await plugin.showView(CHAT_VIEW);
    app.workspace.rightSplit.collapsed = true;
    expect(plugin.chatIsOpen()).toBe(false);
    // A phone's drawer is closed whenever a note is edited.
    Platform.isPhone = true;
    expect(plugin.chatIsOpen()).toBe(true);
  });

  it("is false while another tab is showing in the chat's sidebar", async () => {
    await plugin.showView(CHAT_VIEW);
    const leaf = chatLeaves()[0]!;
    const other = {};
    (leaf as unknown as { parent: unknown }).parent = { children: [other, leaf], currentTab: 0 };
    expect(plugin.chatIsOpen()).toBe(false);
  });
});

describe("adding a selection", () => {
  it("opens the chat first when it is not open, also on a phone", async () => {
    Platform.isPhone = true;
    await plugin.addToChat("Plan %.md", { start: 2, end: 4 });
    expect(chatLeaves()).toHaveLength(1);
  });
});
