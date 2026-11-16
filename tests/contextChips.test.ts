// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAT_VIEW, ChatView } from "../src/chatView";
import ClaudeWatcherPlugin from "../src/main";
import type { ApprovalRequest, ChatSession } from "../src/shared/types";
import { App, Notice, Platform, TFile } from "./support/obsidian";

type TestPlugin = ClaudeWatcherPlugin & {
  commands: {
    id: string;
    editorCheckCallback?: (checking: boolean, editor: unknown, info: unknown) => boolean;
  }[];
};

let app: App;
let plugin: TestPlugin;
let client: Record<string, ReturnType<typeof vi.fn>>;
let requests: ApprovalRequest[];

const reply = (body: { message?: string }): ChatSession =>
  ({
    id: "s1",
    status: "idle",
    createdAt: "2026-11-16T10:00:00Z",
    updatedAt: "2026-11-16T10:00:00Z",
    messages: [{ role: "owner", text: body.message ?? "", at: "2026-11-16T10:00:00Z" }],
  }) as ChatSession;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function chat(): ChatView {
  const leaf = app.workspace.leaves.find((l) => l.view?.getViewType() === CHAT_VIEW)!;
  return leaf.view as unknown as ChatView;
}

const chips = () =>
  [...chat().contentEl.querySelectorAll(".cw-composer .cw-chip")].map(
    (chip) => chip.querySelector(".cw-chip-label")!.textContent,
  );

async function send(text: string): Promise<void> {
  chat().contentEl.querySelector("textarea")!.value = text;
  chat().contentEl.querySelector<HTMLButtonElement>(".cw-composer-row .mod-cta")!.click();
  await settle();
}

/** A stand-in for Obsidian's editor with lines 12 to 18 selected. */
const editor = {
  somethingSelected: () => true,
  getCursor: (which: string) => (which === "from" ? { line: 11, ch: 2 } : { line: 18, ch: 0 }),
};

beforeEach(async () => {
  Platform.isPhone = false;
  Notice.shown = [];
  app = new App();
  app.vault.files = [new TFile("Plan %.md"), new TFile("Diary.md")];
  plugin = new (ClaudeWatcherPlugin as unknown as new (app: App) => TestPlugin)(app);
  await plugin.onload();
  requests = [];
  client = {
    sessions: vi.fn(async () => []),
    session: vi.fn(),
    startSession: vi.fn(async (body) => reply(body)),
    sendMessage: vi.fn(),
    reject: vi.fn(async () => ({})),
    shareSelection: vi.fn(async (body: { notePath: string; range: ApprovalRequest["range"] }) => {
      const request = {
        id: `a${requests.length + 1}`,
        ...body,
        query: "",
        status: "pending",
        source: "owner",
        createdAt: "2026-11-16T10:00:00Z",
      } as ApprovalRequest;
      requests.push(request);
      return request;
    }),
    approvals: vi.fn(async () => requests),
  };
  Object.assign(plugin.client, client);
  // The server is not reached in tests; pending approvals come from `requests`.
  plugin.refresh = async () => {
    plugin.approvals = requests.filter((request) => request.status === "pending");
    await plugin.contextApprovals.check();
  };
  await plugin.newChat();
  await settle();
});

describe("the open note", () => {
  it("is attached by default when it is shared, and removed with its x", async () => {
    plugin.followSelection("Plan %.md", undefined);
    expect(chips()).toEqual(["Plan %"]);
    plugin.followSelection("Plan %.md", { start: 12, end: 18 });
    expect(chips()).toEqual(["Plan %:12-18"]);

    await send("Tidy this up");
    expect(client.startSession).toHaveBeenCalledWith({
      message: "Tidy this up",
      context: [{ notePath: "Plan %.md", startLine: 12, endLine: 18 }],
      task: "simple",
    });

    chat().contentEl.querySelector<HTMLButtonElement>(".cw-composer .cw-chip-remove")!.click();
    await settle();
    expect(chips()).toEqual([]);
  });

  it("is not attached when it is private", () => {
    plugin.followSelection("Diary.md", { start: 1, end: 3 });
    expect(chips()).toEqual([]);
  });
});

describe("adding a selection", () => {
  it("is a command and a note-menu entry that names the lines", async () => {
    const add = plugin.commands.find((c) => c.id === "add-selection-to-chat")!;
    expect(add.editorCheckCallback!(true, editor, { file: app.vault.files[0] })).toBe(true);
    add.editorCheckCallback!(false, editor, { file: app.vault.files[0] });
    await settle();
    expect(chips()).toContain("Plan %:12-18");

    const titles: string[] = [];
    const menu = {
      addItem(build: (item: object) => void) {
        const item = {
          setTitle: (title: string) => (titles.push(title), item),
          setIcon: () => item,
          onClick: () => item,
        };
        build(item);
      },
    };
    app.workspace.trigger("editor-menu", menu, editor, { file: app.vault.files[1] });
    expect(titles).toContain("Add lines 12-18 to Claude chat");
  });

  it("from a shared note sends its path and lines, then clears the chip", async () => {
    await plugin.addToChat("Plan %.md", { start: 2, end: 4 });
    expect(client.shareSelection).not.toHaveBeenCalled();
    await send("Explain");
    expect(client.startSession!.mock.calls[0]![0].context).toEqual([
      { notePath: "Plan %.md", startLine: 2, endLine: 4 },
    ]);
    expect(chips()).toEqual([]);
  });

  it("from a private note asks for approval and sends nothing until approved", async () => {
    await plugin.addToChat("Diary.md", { start: 7, end: 9 });
    expect(client.shareSelection).toHaveBeenCalledWith({
      notePath: "Diary.md",
      range: { kind: "lines", start: 7, end: 9 },
    });
    expect(chips()).toEqual(["Diary:7-9"]);

    await send("What did I decide?");
    expect(client.startSession).not.toHaveBeenCalled();
    expect(chat().contentEl.querySelector(".cw-status")!.textContent).toContain("approve");

    requests[0]!.status = "approved";
    await plugin.refresh();
    await settle();
    expect(client.startSession).toHaveBeenCalledWith({
      message: "What did I decide?",
      context: [{ notePath: "Diary.md", startLine: 7, endLine: 9, approvalId: "a1" }],
      task: "simple",
    });
  });

  it("from a private note is left out when rejected, and the message still goes", async () => {
    await plugin.addToChat("Diary.md", { start: 7, end: 9 });
    await send("Anything?");
    requests[0]!.status = "rejected";
    await plugin.refresh();
    await settle();
    expect(client.startSession).toHaveBeenCalledWith({ message: "Anything?", task: "simple" });
    expect(Notice.shown.some((text) => text.includes("rejected"))).toBe(true);
  });

  it("withdraws a private selection's request when its chip is removed", async () => {
    await plugin.addToChat("Diary.md", { start: 7, end: 9 });
    chat().contentEl.querySelector<HTMLButtonElement>(".cw-composer .cw-chip-remove")!.click();
    await settle();
    expect(client.reject).toHaveBeenCalledWith("a1");
    expect(chips()).toEqual([]);
  });
});

describe("sent messages", () => {
  it("show what was attached, without an x", async () => {
    client.startSession!.mockImplementationOnce(async (body) => {
      const session = reply(body);
      session.messages[0]!.context = body.context;
      return session;
    });
    await plugin.addToChat("Plan %.md", { start: 2, end: 4 });
    await send("Explain");
    const sent = chat().contentEl.querySelector(".cw-messages .cw-chip")!;
    expect(sent.textContent).toContain("Plan %:2-4");
    expect(sent.querySelector(".cw-chip-remove")).toBeNull();
  });
});
