// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAT_VIEW, ChatView, EMPTY_STATE } from "../src/chatView";
import ClaudeWatcherPlugin from "../src/main";
import type { ChatSession } from "../src/shared/types";
// The same module the plugin gets for "obsidian" (see vitest.config.mjs).
import { App, Platform, TFile, type WorkspaceLeaf } from "./support/obsidian";

type TestApp = App;
type TestPlugin = ClaudeWatcherPlugin & {
  ribbon: { icon: string; title: string; onClick: () => void }[];
  commands: {
    id: string;
    name: string;
    icon?: string;
    callback?: () => void;
    checkCallback?: (checking: boolean) => boolean;
  }[];
};

const earlier: ChatSession = {
  id: "s1",
  status: "idle",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:05:00Z",
  messages: [{ role: "owner", text: "An earlier chat", at: "2026-11-01T10:00:00Z" }],
} as ChatSession;

let app: TestApp;
let plugin: TestPlugin;
let client: Record<string, ReturnType<typeof vi.fn>>;

async function load(): Promise<void> {
  app = new App() as TestApp;
  app.vault.files = [new TFile("Projects/Garden plan.md")];
  plugin = new (ClaudeWatcherPlugin as unknown as new (app: App) => TestPlugin)(app);
  await plugin.onload();
  client = {
    sessions: vi.fn(async () => [earlier]),
    session: vi.fn(async () => earlier),
    startSession: vi.fn(async (body: { message?: string }) => ({
      ...earlier,
      id: "s2",
      status: "idle",
      messages: [{ role: "owner", text: body.message ?? "", at: "2026-11-15T10:00:00Z" }],
    })),
    sendMessage: vi.fn(),
  };
  Object.assign(plugin.client, client);
}

function command(id: string) {
  return plugin.commands.find((c) => c.id === id)!;
}

function chatLeaves(): WorkspaceLeaf[] {
  return app.workspace.leaves.filter((leaf) => leaf.view?.getViewType() === CHAT_VIEW);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function chat(): ChatView {
  const view = chatLeaves()[0]!.view;
  expect(view).toBeInstanceOf(ChatView);
  return view as unknown as ChatView;
}

function input(): HTMLTextAreaElement {
  return chat().contentEl.querySelector(".cw-composer textarea")!;
}

beforeEach(async () => {
  Platform.isPhone = false;
  document.body.replaceChildren();
  await load();
});

describe("starting a new chat", () => {
  it("offers a ribbon icon and commands that need no note", () => {
    expect(plugin.ribbon.map((r) => r.title)).toContain("New Claude chat");
    expect(command("new-chat").name).toBe("New chat");
    expect(command("new-chat").icon).toBeTruthy();
    expect(command("new-chat-about-note").name).toBe("New chat about this note");
    expect(command("open-chat")).toBeDefined();
  });

  it("opens an empty chat with the message box focused, even when older chats exist", async () => {
    plugin.ribbon.find((r) => r.title === "New Claude chat")!.onClick();
    await settle();
    const root = chat().contentEl;
    document.body.appendChild(root);
    chat().newChat();
    expect(root.querySelector(".cw-chat-empty")?.textContent).toContain(EMPTY_STATE.intro);
    expect(root.querySelector(".cw-new-chat")?.textContent).toBe("New chat");
    expect(document.activeElement).toBe(input());
    expect(root.querySelector<HTMLSelectElement>(".cw-chat-toolbar select")!.value).toBe("");
  });

  it("stays on the new chat when the list of chats reloads", async () => {
    command("new-chat").callback!();
    await settle();
    await chat().reload();
    expect(chat().contentEl.querySelector(".cw-chat-empty")).not.toBeNull();
  });

  it("sends the first message as a chat with no note attached", async () => {
    command("new-chat").callback!();
    await settle();
    input().value = "What did I plan for the garden?";
    chat().contentEl.querySelector<HTMLButtonElement>(".mod-cta")!.click();
    await settle();
    expect(client.startSession).toHaveBeenCalledWith({
      message: "What did I plan for the garden?",
      task: "simple",
    });
  });

  it("opens in the right sidebar on a desktop", async () => {
    command("new-chat").callback!();
    await settle();
    expect(chatLeaves()).toHaveLength(1);
    expect(chatLeaves()[0]!.getRoot()).toBe(app.workspace.rightSplit);
  });

  it("opens as a full tab on a phone and replaces a chat left in the drawer", async () => {
    command("open-chat").callback!();
    await settle();
    expect(chatLeaves()[0]!.getRoot()).toBe(app.workspace.rightSplit);

    Platform.isPhone = true;
    command("new-chat").callback!();
    await settle();
    expect(chatLeaves()).toHaveLength(1);
    expect(chatLeaves()[0]!.getRoot()).toBe(app.workspace.rootSplit);

    command("new-chat").callback!();
    await settle();
    expect(chatLeaves()).toHaveLength(1);
  });
});

describe("a new chat about a note", () => {
  it("is offered only while a note is open", () => {
    expect(command("new-chat-about-note").checkCallback!(true)).toBe(false);
    app.workspace.activeFile = app.vault.files[0]!;
    expect(command("new-chat-about-note").checkCallback!(true)).toBe(true);
  });

  it("starts the message with a link to the note and sends nothing yet", async () => {
    app.workspace.activeFile = app.vault.files[0]!;
    command("new-chat-about-note").checkCallback!(false);
    await settle();
    expect(input().value).toBe("[[Projects/Garden plan.md]] ");
    expect(client.startSession).not.toHaveBeenCalled();
  });

  it("is in the note's menu", async () => {
    const items: { title?: string; click?: () => void }[] = [];
    const menu = {
      addItem(build: (item: object) => void) {
        const entry: { title?: string; click?: () => void } = {};
        const item = {
          setTitle: (t: string) => ((entry.title = t), item),
          setIcon: () => item,
          onClick: (fn: () => void) => ((entry.click = fn), item),
        };
        build(item);
        items.push(entry);
      },
    };
    app.workspace.trigger("file-menu", menu, app.vault.files[0]);
    expect(items[0]!.title).toBe("New Claude chat about this note");
    items[0]!.click!();
    await settle();
    expect(input().value).toBe("[[Projects/Garden plan.md]] ");
  });
});
