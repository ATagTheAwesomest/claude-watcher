/**
 * The chat sidebar. Start a chat by typing a message, or from a note's
 * "<c: ...>" instructions. Messages can link notes with [[...]]. Claude's
 * replies and proposed edits appear below, and follow-up messages continue
 * the same Claude Code session on the server.
 */

import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";

import type ClaudeWatcherPlugin from "./main";
import { NotePicker, linkFor, linkTarget, resolveLinks } from "./noteLinks";
import type { ChatMessage, ChatSession, PendingChange, TaskSize } from "./shared/types";

export const CHAT_VIEW = "claude-watcher-chat";

/** How often a running conversation is checked, in milliseconds. */
const RUN_POLL_MS = 2000;

export class ChatView extends ItemView {
  private session: ChatSession | undefined;
  private sessions: ChatSession[] = [];
  private pickerEl!: HTMLSelectElement;
  private messagesEl!: HTMLElement;
  private editsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private taskEl!: HTMLSelectElement;
  private sendEl!: HTMLButtonElement;
  private runTimer: number | undefined;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ClaudeWatcherPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CHAT_VIEW;
  }

  getDisplayText(): string {
    return "Claude chat";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("cw-chat");

    const toolbar = root.createDiv({ cls: "cw-chat-toolbar" });
    this.pickerEl = toolbar.createEl("select", { cls: "dropdown" });
    this.pickerEl.addEventListener("change", () => void this.open(this.pickerEl.value));
    const newChat = toolbar.createEl("button", { attr: { "aria-label": "New chat" } });
    setIcon(newChat, "plus");
    newChat.addEventListener("click", () => this.show(undefined));
    const reload = toolbar.createEl("button", { attr: { "aria-label": "Reload" } });
    setIcon(reload, "refresh-cw");
    reload.addEventListener("click", () => void this.reload());

    this.messagesEl = root.createDiv({ cls: "cw-messages" });
    this.messagesEl.addEventListener("click", (event) => this.followLink(event));
    this.editsEl = root.createDiv({ cls: "cw-edits" });
    this.statusEl = root.createDiv({ cls: "cw-status" });

    const composer = root.createDiv({ cls: "cw-composer" });
    this.inputEl = composer.createEl("textarea", {
      attr: { placeholder: "Message Claude. Type [[ to link a note.", rows: "3" },
    });
    this.inputEl.addEventListener("input", () => {
      const before = this.inputEl.value.slice(0, this.inputEl.selectionStart);
      if (before.endsWith("[[")) this.pickNote(true);
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send();
      }
    });
    const row = composer.createDiv({ cls: "cw-composer-row" });
    this.taskEl = row.createEl("select", { cls: "dropdown" });
    this.taskEl.createEl("option", { value: "simple", text: "Simple task" });
    this.taskEl.createEl("option", { value: "complex", text: "Complex task" });
    this.taskEl.value = this.plugin.settings.defaultTask;
    const links = row.createDiv({ cls: "cw-composer-links" });
    const linkNote = links.createEl("button", { attr: { "aria-label": "Link a note" } });
    setIcon(linkNote, "link");
    linkNote.addEventListener("click", () => this.pickNote(false));
    const linkCurrent = links.createEl("button", {
      attr: { "aria-label": "Link the current note" },
    });
    setIcon(linkCurrent, "file-plus");
    linkCurrent.addEventListener("click", () => {
      const file = this.app.workspace.getActiveFile();
      if (file) this.insert(linkFor(file));
      else new Notice("Open a note first.");
    });
    this.sendEl = row.createEl("button", { text: "Send", cls: "mod-cta" });
    this.sendEl.addEventListener("click", () => void this.send());

    this.registerEvent(this.plugin.events.on("changes", () => this.renderEdits()));
    await this.reload();
  }

  async onClose(): Promise<void> {
    window.clearTimeout(this.runTimer);
  }

  /** Starts a conversation from the instructions of a note. */
  async startFromNote(file: TFile): Promise<void> {
    await this.run(() =>
      this.plugin.client.startSession({ notePath: file.path, task: this.task() }),
    );
  }

  /** Reloads the list of conversations and shows the current or the latest one. */
  async reload(): Promise<void> {
    try {
      this.sessions = await this.plugin.client.sessions();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const current = this.session && this.sessions.find((s) => s.id === this.session!.id);
    this.show(current ?? this.sessions[0]);
  }

  private async open(id: string): Promise<void> {
    if (id === "") return this.show(undefined);
    try {
      this.show(await this.plugin.client.session(id));
    } catch (error) {
      this.fail(error);
    }
  }

  private show(session: ChatSession | undefined): void {
    this.session = session;
    if (session && !this.sessions.some((s) => s.id === session.id)) {
      this.sessions.unshift(session);
    }
    this.renderPicker();
    void this.renderMessages();
    this.renderEdits();
    const running = session?.status === "running";
    this.statusEl.setText(running ? "Claude is working…" : "");
    this.statusEl.toggleClass("is-running", running);
    this.sendEl.disabled = running;
    window.clearTimeout(this.runTimer);
    if (running) this.runTimer = window.setTimeout(() => void this.poll(), RUN_POLL_MS);
  }

  /** Checks a running conversation until Claude has answered. */
  private async poll(): Promise<void> {
    if (!this.session) return;
    try {
      const session = await this.plugin.client.session(this.session.id);
      if (session.id !== this.session?.id) return;
      this.show(session);
      if (session.status === "idle") await this.plugin.refresh();
    } catch (error) {
      this.fail(error);
      this.runTimer = window.setTimeout(() => void this.poll(), RUN_POLL_MS * 3);
    }
  }

  /** Lets the owner pick a note and links it at the cursor. After "[[", completes that link. */
  private pickNote(afterBrackets: boolean): void {
    new NotePicker(this.app, (file) => {
      const link = linkFor(file);
      this.insert(afterBrackets ? link.slice(2) : link);
    }).open();
  }

  private insert(text: string): void {
    const input = this.inputEl;
    const at = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? at;
    input.value = input.value.slice(0, at) + text + input.value.slice(end);
    input.selectionStart = input.selectionEnd = at + text.length;
    input.focus();
  }

  /** Opens the note behind a link in a message, if it is in the vault. */
  private followLink(event: MouseEvent): void {
    const link = (event.target as HTMLElement).closest("a.internal-link");
    const href = link?.getAttribute("data-href") ?? link?.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    const file = linkTarget(this.app, href, this.session?.notePath ?? "");
    if (file) void this.plugin.openNote(file.path);
    else new Notice(`${href} is not in this vault.`);
  }

  private async send(): Promise<void> {
    const message = resolveLinks(this.app, this.inputEl.value.trim());
    if (message === "" || this.sendEl.disabled) return;
    const task = this.task();
    const session = this.session;
    const ok = await this.run(() =>
      session
        ? this.plugin.client.sendMessage(session.id, { message, task })
        : this.plugin.client.startSession({ message, task }),
    );
    if (ok) this.inputEl.value = "";
  }

  private async run(request: () => Promise<ChatSession>): Promise<boolean> {
    this.sendEl.disabled = true;
    try {
      this.show(await request());
      return true;
    } catch (error) {
      this.fail(error);
      this.sendEl.disabled = this.session?.status === "running";
      return false;
    }
  }

  private task(): TaskSize {
    return this.taskEl.value === "complex" ? "complex" : "simple";
  }

  private renderPicker(): void {
    this.pickerEl.empty();
    this.pickerEl.createEl("option", { value: "", text: "New chat" });
    for (const session of this.sessions) {
      this.pickerEl.createEl("option", { value: session.id, text: label(session) });
    }
    this.pickerEl.value = this.session?.id ?? "";
  }

  private async renderMessages(): Promise<void> {
    const el = this.messagesEl;
    el.empty();
    if (!this.session) {
      el.createDiv({
        cls: "cw-empty",
        text: "Write a message below to start a chat. Link notes with [[...]]; Claude only sees a linked note's path until you approve more. You can also run “Send this note's instructions to Claude” on a %% note.",
      });
      return;
    }
    for (const message of this.session.messages) {
      const bubble = el.createDiv({ cls: `cw-message cw-from-${message.role}` });
      if (message.error) bubble.addClass("is-error");
      bubble.createDiv({
        cls: "cw-message-author",
        text: message.role === "owner" ? "You" : "Claude",
      });
      const body = bubble.createDiv({ cls: "cw-message-body" });
      if (message.pointer) await this.renderInstructions(body, message);
      if (message.text !== "") {
        const sourcePath = this.session.notePath ?? "";
        await MarkdownRenderer.render(this.app, message.text, body.createDiv(), sourcePath, this);
      }
    }
    el.scrollTop = el.scrollHeight;
  }

  /** Shows the instructions a message points to, read from the vault. */
  private async renderInstructions(body: HTMLElement, message: ChatMessage): Promise<void> {
    const pointer = message.pointer!;
    const file = this.app.vault.getAbstractFileByPath(pointer.notePath);
    const lines = file instanceof TFile ? (await this.app.vault.read(file)).split("\n") : [];
    for (const { startLine, endLine } of pointer.instructions) {
      const block = body.createDiv({ cls: "cw-instruction" });
      const text = lines.slice(startLine - 1, endLine).join("\n");
      block.createDiv({ text: text || "(instruction no longer in the note)" });
      const jump = block.createEl("a", {
        cls: "cw-jump",
        text: `${pointer.notePath}, ${startLine === endLine ? `line ${startLine}` : `lines ${startLine} to ${endLine}`}`,
      });
      jump.addEventListener(
        "click",
        () => void this.plugin.openNote(pointer.notePath, { start: startLine, end: endLine }),
      );
    }
  }

  /** Lists the edits this conversation proposed that are still pending. */
  private renderEdits(): void {
    const el = this.editsEl;
    el.empty();
    const changes = this.session
      ? this.plugin.changes.filter((change) => change.sessionId === this.session!.id)
      : [];
    if (changes.length === 0) return;
    el.createDiv({ cls: "cw-edits-title", text: "Proposed edits" });
    for (const change of changes) {
      const row = el.createDiv({ cls: "cw-edit" });
      const jump = row.createEl("a", { cls: "cw-jump", text: describeChange(change) });
      jump.addEventListener(
        "click",
        () =>
          void this.plugin.openNote(change.notePath, {
            start: change.startLine,
            end: Math.max(change.endLine, change.startLine),
          }),
      );
      this.plugin.review.buttons(row, change);
    }
  }

  private fail(error: unknown): void {
    new Notice(error instanceof Error ? error.message : String(error));
  }
}

function label(session: ChatSession): string {
  const first = session.messages.find((message) => message.role === "owner" && message.text);
  const title = session.notePath ?? first?.text ?? "Chat";
  const short = title.length > 40 ? `${title.slice(0, 39)}…` : title;
  return `${short} · ${new Date(session.updatedAt).toLocaleString()}`;
}

export function describeChange(change: PendingChange): string {
  const { notePath, startLine, endLine, lines } = change;
  if (endLine < startLine)
    return `${notePath}: insert ${lines.length} line(s) at line ${startLine}`;
  const where = startLine === endLine ? `line ${startLine}` : `lines ${startLine} to ${endLine}`;
  return lines.length === 0 ? `${notePath}: remove ${where}` : `${notePath}: change ${where}`;
}
