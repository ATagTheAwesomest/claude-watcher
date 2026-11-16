// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WatcherError } from "../src/api";
import { CHAT_VIEW, ChatView, DEFAULT_EXCERPT_QUESTION } from "../src/chatView";
import { EXCERPT_RETRY_MS } from "../src/contextBar";
import ClaudeWatcherPlugin from "../src/main";
import type { ApprovalRequest, ChatSession, ChatContext } from "../src/shared/types";
import { hashNote } from "../src/text";
import { App, Notice, Platform, TFile } from "./support/obsidian";

type TestPlugin = ClaudeWatcherPlugin & {
  commands: {
    id: string;
    editorCheckCallback?: (checking: boolean, editor: unknown, info: unknown) => boolean;
  }[];
};

const DIARY = "Private.\nThe part I ask about.\nSecret PIN.\n";

let app: App;
let plugin: TestPlugin;
let client: Record<string, ReturnType<typeof vi.fn>>;
let saved: number;

/** A stand-in editor for `text`, with `selected` selected. */
function editorFor(text: string, selected: string) {
  const from = text.indexOf(selected);
  const to = from + selected.length;
  const pos = (offset: number) => {
    const before = text.slice(0, offset).split("\n");
    return { line: before.length - 1, ch: before.at(-1)!.length };
  };
  return {
    somethingSelected: () => selected !== "",
    getCursor: (which: string) => pos(which === "from" ? from : to),
    getValue: () => text,
    posToOffset: ({ line, ch }: { line: number; ch: number }) =>
      text.split("\n").slice(0, line).join("\n").length + (line > 0 ? 1 : 0) + ch,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function chat(): ChatView {
  const leaf = app.workspace.leaves.find((l) => l.view?.getViewType() === CHAT_VIEW)!;
  return leaf.view as unknown as ChatView;
}

const composerChips = () =>
  [...chat().contentEl.querySelectorAll(".cw-composer .cw-chip")].map(
    (chip) => chip.querySelector(".cw-chip-label")!.textContent,
  );

function session(context?: ChatContext[]): ChatSession {
  return {
    id: "s1",
    status: "idle",
    createdAt: "2026-11-16T10:00:00Z",
    updatedAt: "2026-11-16T10:00:00Z",
    messages: [{ role: "owner", text: "Q", at: "2026-11-16T10:00:00Z", context }],
  } as ChatSession;
}

let focused: number;

async function ask(file: TFile, text: string, selected: string): Promise<void> {
  const command = plugin.commands.find((c) => c.id === "ask-about-selection")!;
  command.editorCheckCallback!(false, editorFor(text, selected), { file });
  await settle();
}

beforeEach(async () => {
  Platform.isPhone = false;
  Platform.isMobile = false;
  Notice.shown = [];
  app = new App();
  app.vault.files = [new TFile("Plan %.md"), new TFile("Diary.md")];
  saved = 0;
  app.workspace.activeView = { save: async () => void saved++ };
  plugin = new (ClaudeWatcherPlugin as unknown as new (app: App) => TestPlugin)(app);
  await plugin.onload();
  client = {
    sessions: vi.fn(async () => []),
    session: vi.fn(),
    startSession: vi.fn(async (body: { context?: ChatContext[] }) => session(body.context)),
    shareExcerpt: vi.fn(
      async (body) =>
        ({
          id: "x1",
          ...body,
          query: "",
          status: "approved",
          source: "owner",
          createdAt: "2026-11-16T10:00:00Z",
        }) as ApprovalRequest,
    ),
    withdrawExcerpt: vi.fn(async () => ({})),
    shareSelection: vi.fn(),
  };
  Object.assign(plugin.client, client);
  plugin.refresh = async () => {};
  await plugin.newChat();
  await settle();
  focused = 0;
  chat().contentEl.querySelector("textarea")!.focus = () => void focused++;
});

describe("Ask Claude about this excerpt", () => {
  it("is in the note menu and the command list only with a selection", () => {
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
    const file = app.vault.files[1];
    app.workspace.trigger("editor-menu", menu, editorFor(DIARY, "part"), { file });
    expect(titles).toContain("Ask Claude about this excerpt");

    const command = plugin.commands.find((c) => c.id === "ask-about-selection")!;
    expect(command.editorCheckCallback!(true, editorFor(DIARY, "part"), { file })).toBe(true);
    expect(command.editorCheckCallback!(true, editorFor(DIARY, ""), { file })).toBe(false);
  });

  it("shares exactly the selected characters of a private note, with no card", async () => {
    await ask(app.vault.files[1]!, DIARY, "The part I ask about.");
    expect(saved).toBe(1);
    expect(client.shareExcerpt).toHaveBeenCalledWith({
      notePath: "Diary.md",
      range: { kind: "chars", start: 9, end: 30 },
      noteHash: await hashNote(DIARY),
    });
    expect(client.shareSelection).not.toHaveBeenCalled();
    expect(composerChips()).toEqual(["Diary:2"]);
    expect(focused).toBe(1);
    expect(chat().contentEl.querySelector("textarea")!.placeholder).toContain("excerpt");
  });

  it("sends with no question, naming the excerpt by its request", async () => {
    await ask(app.vault.files[1]!, DIARY, "The part I ask about.");
    chat().contentEl.querySelector<HTMLButtonElement>(".cw-composer-row .mod-cta")!.click();
    await settle();
    expect(client.startSession).toHaveBeenCalledWith({
      message: DEFAULT_EXCERPT_QUESTION,
      context: [{ notePath: "Diary.md", startLine: 2, endLine: 2, approvalId: "x1" }],
      task: "simple",
    });
    expect(composerChips()).toEqual([]);
  });

  it("takes the excerpt back when its chip is removed before sending", async () => {
    await ask(app.vault.files[1]!, DIARY, "The part I ask about.");
    chat().contentEl.querySelector<HTMLButtonElement>(".cw-composer .cw-chip-remove")!.click();
    await settle();
    expect(client.withdrawExcerpt).toHaveBeenCalledWith("x1");
    expect(composerChips()).toEqual([]);
  });

  it("can be taken back from a sent message, which then shows it as ended", async () => {
    client.startSession!.mockImplementationOnce(async (body: { context?: ChatContext[] }) =>
      session(body.context!.map((item) => ({ ...item, excerpt: "active" as const }))),
    );
    await ask(app.vault.files[1]!, DIARY, "The part I ask about.");
    chat().contentEl.querySelector("textarea")!.value = "What is this?";
    chat().contentEl.querySelector<HTMLButtonElement>(".cw-composer-row .mod-cta")!.click();
    await settle();

    const sent = () => chat().contentEl.querySelector(".cw-messages .cw-chip")!;
    expect(sent().querySelector(".cw-chip-remove")).not.toBeNull();
    client.session!.mockResolvedValueOnce(
      session([
        { notePath: "Diary.md", startLine: 2, endLine: 2, approvalId: "x1", excerpt: "ended" },
      ]),
    );
    sent().querySelector<HTMLButtonElement>(".cw-chip-remove")!.click();
    await settle();
    expect(client.withdrawExcerpt).toHaveBeenCalledWith("x1");
    expect(sent().classList.contains("is-ended")).toBe(true);
    expect(sent().querySelector(".cw-chip-remove")).toBeNull();
  });

  it("attaches a shared note by its lines, without the server", async () => {
    const plan = "# Plan\nStep one.\nStep two.\n";
    await ask(app.vault.files[0]!, plan, "Step one.\nStep two.");
    expect(client.shareExcerpt).not.toHaveBeenCalled();
    expect(composerChips()).toContain("Plan %:2-3");
  });

  it("waits for sync when the server's copy differs, then gives up with a notice", async () => {
    vi.useFakeTimers();
    try {
      client.shareExcerpt!.mockRejectedValue(
        new WatcherError(409, "note_changed", "The note on the server differs"),
      );
      const done = plugin.contextApprovals.ask(
        app.vault.files[1]! as never,
        DIARY,
        { start: 2, end: 2 },
        { start: 9, end: 30 },
      );
      for (const wait of EXCERPT_RETRY_MS) await vi.advanceTimersByTimeAsync(wait);
      expect(await done).toBe(false);
      expect(client.shareExcerpt).toHaveBeenCalledTimes(EXCERPT_RETRY_MS.length + 1);
      expect(Notice.shown.at(-1)).toContain("Wait for sync");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not focus the message box on a phone", async () => {
    Platform.isMobile = true;
    await ask(app.vault.files[1]!, DIARY, "The part I ask about.");
    expect(composerChips()).toEqual(["Diary:2"]);
    expect(focused).toBe(0);
  });
});
