/**
 * The chat panel. Start a chat at any time by typing a message, with or
 * without a note, or from a note's "<c: ...>" instructions. Messages can link notes with [[...]]. Claude's
 * replies and proposed edits appear below, and follow-up messages continue
 * the same Claude Code session on the server.
 */

import {
  ItemView,
  MarkdownRenderer,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";

import { WatcherError } from "./api";
import { chipsOf, renderChips } from "./contextBar";
import type ClaudeWatcherPlugin from "./main";
import { NotePicker, linkFor, linkTarget, resolveLinks } from "./noteLinks";
import {
  DEFAULT_EFFORT,
  EFFORT_LABELS,
  choiceFields,
  choiceFor,
  defaultEffortLabel,
  modelLabel,
  type RunChoice,
} from "./runChoice";
import type { ChatMessage, ChatSession, PendingChange, TaskSize } from "./shared/types";

export const CHAT_VIEW = "claude-watcher-chat";

/** How often a running conversation is checked, in milliseconds. */
const RUN_POLL_MS = 2000;

/**
 * The picker entry for a new chat. Not empty: an option with an empty value
 * falls back to its text ("New chat"), which would be sent as a conversation id.
 */
export const NEW_CHAT = "new";

export class ChatView extends ItemView {
  private session: ChatSession | undefined;
  private sessions: ChatSession[] = [];
  private pickerEl!: HTMLSelectElement;
  private messagesEl!: HTMLElement;
  private editsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  /** Model and effort pickers, shown when the server lists its models. */
  private modelEl!: HTMLSelectElement;
  private effortEl!: HTMLSelectElement;
  /** Task size picker, for servers too old to list their models. */
  private taskEl!: HTMLSelectElement;
  /** The model and effort picked for each chat, by id, "new" for an unsent one. */
  private choices = new Map<string, RunChoice>();
  /** The chat the pickers were last set for. */
  private choiceKey: string | undefined;
  private sendEl!: HTMLButtonElement;
  private chipsEl!: HTMLElement;
  private runTimer: number | undefined;
  /** True while the owner is on a new, unsent chat, so a reload keeps it. */
  private fresh = false;
  /** Set once onOpen has built the panel. */
  private built = false;
  /** A new chat asked for before the panel was built, opened once it is. */
  private pendingNewChat: { about?: TFile } | undefined;

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
    try {
      this.build();
    } catch (error) {
      // A panel that fails to build says why, instead of staying blank.
      console.error("Claude Watcher: the chat panel failed to open", error);
      showBroken(this.contentEl, error);
      return;
    }
    await this.reload();
  }

  private build(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("cw-chat");

    const toolbar = root.createDiv({ cls: "cw-chat-toolbar" });
    this.pickerEl = toolbar.createEl("select", { cls: "dropdown" });
    this.pickerEl.addEventListener("change", () => void this.openChat(this.pickerEl.value));
    const newChat = toolbar.createEl("button", { cls: "cw-new-chat" });
    setIcon(newChat.createSpan(), "message-square-plus");
    newChat.createSpan({ text: "New chat" });
    newChat.addEventListener("click", () => this.newChat());
    const reload = toolbar.createEl("button", { attr: { "aria-label": "Reload" } });
    setIcon(reload, "refresh-cw");
    reload.addEventListener("click", () => void this.reload());

    this.messagesEl = root.createDiv({ cls: "cw-messages" });
    this.messagesEl.addEventListener("click", (event) => this.followLink(event));
    this.editsEl = root.createDiv({ cls: "cw-edits" });
    this.statusEl = root.createDiv({ cls: "cw-status" });

    const composer = root.createDiv({ cls: "cw-composer" });
    this.chipsEl = composer.createDiv({ cls: "cw-context" });
    this.renderContext();
    const stopFollowing = this.plugin.context.onChange(() => this.renderContext());
    this.register(stopFollowing);
    // A message held for approvals goes once they are settled.
    this.registerEvent(this.plugin.events.on("context-ready", () => void this.send()));
    this.inputEl = composer.createEl("textarea", {
      attr: { placeholder: "Ask Claude about your notes. Type [[ to link one.", rows: "3" },
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
    const pickers = composer.createDiv({ cls: "cw-composer-row cw-run-choice" });
    this.modelEl = pickers.createEl("select", {
      cls: "dropdown cw-model",
      attr: { "aria-label": "Model" },
    });
    this.effortEl = pickers.createEl("select", {
      cls: "dropdown cw-effort",
      attr: { "aria-label": "Thinking effort" },
    });
    this.taskEl = pickers.createEl("select", { cls: "dropdown cw-task" });
    this.taskEl.createEl("option", { text: "Simple task" }).value = "simple";
    this.taskEl.createEl("option", { text: "Complex task" }).value = "complex";
    this.taskEl.value = "simple";
    for (const picker of [this.modelEl, this.effortEl]) {
      picker.addEventListener("change", () => this.rememberChoice());
    }
    const row = composer.createDiv({ cls: "cw-composer-row" });
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
    this.registerEvent(
      this.plugin.events.on("claude-options", () => {
        this.choiceKey = undefined;
        this.renderChoice();
      }),
    );
    this.built = true;
    this.renderChoice();
    const pending = this.pendingNewChat;
    this.pendingNewChat = undefined;
    if (pending) this.newChat(pending.about);
  }

  async onClose(): Promise<void> {
    window.clearTimeout(this.runTimer);
  }

  /**
   * Shows an empty chat with the message box focused. With `about`, the box
   * starts with a link to that note.
   */
  newChat(about?: TFile): void {
    if (!this.built) {
      this.pendingNewChat = { about };
      return;
    }
    if (this.session) this.inputEl.value = "";
    this.show(undefined);
    if (about) this.insert(`${linkFor(about)} `, false);
    // On iOS, focusing the box while the panel opens scrolls the whole app out
    // of view and leaves a black screen. On mobile the owner taps the box instead.
    if (!Platform.isMobile) this.focusInput();
  }

  private focusInput(): void {
    this.inputEl.focus({ preventScroll: true });
  }

  /** Starts a conversation from the instructions of a note. */
  async startFromNote(file: TFile): Promise<void> {
    await this.run(() =>
      this.plugin.client.startSession({ notePath: file.path, ...this.runFields() }),
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
    this.show(current ?? (this.fresh ? undefined : this.sessions[0]));
  }

  /**
   * Shows a conversation picked from the list. Not named `open`: Obsidian
   * mounts every view by calling its `open(containerEl)`, and a method of that
   * name here would replace it, leaving the panel blank.
   */
  private async openChat(id: string): Promise<void> {
    if (id === NEW_CHAT || id === "") return this.newChat();
    try {
      this.show(await this.plugin.client.session(id));
    } catch (error) {
      if (!this.forgetIfGone(error, id)) this.fail(error);
    }
  }

  /**
   * When the server no longer has a conversation (it was cleared or the server
   * started over), drops it and shows a new chat instead. Returns true if so.
   */
  private forgetIfGone(error: unknown, id: string): boolean {
    if (!(error instanceof WatcherError) || error.status !== 404) return false;
    this.sessions = this.sessions.filter((session) => session.id !== id);
    if (this.session?.id === id) this.session = undefined;
    console.warn("Claude Watcher: the server has no chat", id, error.request);
    new Notice("That chat is no longer on the server. Starting a new chat.");
    this.newChat();
    this.statusEl.setText(
      `The server had no chat with id ${id} (${error.request ?? "unknown request"}).`,
    );
    return true;
  }

  private show(session: ChatSession | undefined): void {
    this.session = session;
    this.fresh = session === undefined;
    if (session && !this.sessions.some((s) => s.id === session.id)) {
      this.sessions.unshift(session);
    }
    this.renderPicker();
    this.renderChoice();
    this.renderMessages().catch((error: unknown) => {
      console.error("Claude Watcher: could not show the messages", error);
      this.messagesEl.empty();
      showBroken(this.messagesEl, error);
    });
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
      if (this.forgetIfGone(error, this.session.id)) return;
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

  /** Puts text at the cursor. Focuses the box unless `focus` is false. */
  private insert(text: string, focus = true): void {
    const input = this.inputEl;
    const at = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? at;
    input.value = input.value.slice(0, at) + text + input.value.slice(end);
    input.selectionStart = input.selectionEnd = at + text.length;
    if (focus) this.focusInput();
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
    // Private selections wait for approval; the message is sent once they are settled.
    this.sendEl.disabled = true;
    const context = await this.plugin.contextApprovals.prepare().catch((error: unknown) => {
      this.fail(error);
      return null;
    });
    this.sendEl.disabled = this.session?.status === "running";
    if (context === null) return;
    if (context === undefined) {
      this.statusEl.setText("Waiting for you to approve the private selection before sending…");
      return;
    }
    const fields = context.length > 0 ? { ...this.runFields(), context } : this.runFields();
    const session = this.session;
    const ok = await this.run(async () => {
      if (!session) return this.plugin.client.startSession({ message, ...fields });
      try {
        return await this.plugin.client.sendMessage(session.id, { message, ...fields });
      } catch (error) {
        // The chat is gone from the server: the message starts a new one instead.
        if (!(error instanceof WatcherError) || error.status !== 404) throw error;
        this.sessions = this.sessions.filter((s) => s.id !== session.id);
        new Notice("That chat is no longer on the server. Your message starts a new chat.");
        return this.plugin.client.startSession({ message, ...fields });
      }
    });
    if (ok) {
      this.inputEl.value = "";
      this.plugin.context.clearAdded();
    }
  }

  /** The chips of the message being written. */
  private renderContext(): void {
    renderChips(this.chipsEl, this.plugin.context.chips(), {
      remove: (chip) => void this.plugin.contextApprovals.remove(chip),
      open: (chip) => void this.openChip(chip.notePath, chip.lines),
    });
  }

  private async openChip(notePath: string, lines?: { start: number; end: number }) {
    await this.plugin.openNote(notePath, lines);
  }

  private async run(request: () => Promise<ChatSession>): Promise<boolean> {
    this.sendEl.disabled = true;
    const key = this.session?.id ?? NEW_CHAT;
    try {
      const session = await request();
      // The server now records the pick with the chat, so it is shown from there.
      this.choices.delete(key);
      if (key === this.choiceKey) this.choiceKey = undefined;
      this.show(session);
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

  /** The model and effort, or the task size for an older server, to send with a message. */
  private runFields(): ReturnType<typeof choiceFields> {
    const options = this.plugin.claudeOptions;
    const choice = options ? this.pickedChoice() : undefined;
    return choiceFields(options, choice, this.task());
  }

  private pickedChoice(): RunChoice {
    const effort = this.effortEl.value;
    return {
      model: this.modelEl.value,
      effort: effort === "" ? DEFAULT_EFFORT : (effort as RunChoice["effort"]),
    };
  }

  /** Keeps a changed pick for the chat on screen, so switching chats does not lose it. */
  private rememberChoice(): void {
    if (!this.plugin.claudeOptions) return;
    this.choices.set(this.session?.id ?? NEW_CHAT, this.pickedChoice());
  }

  /**
   * Sets the pickers for the chat on screen: the pick made for it here, the
   * model and effort it last ran with, or the defaults. Left alone while the
   * same chat stays on screen, so a poll does not undo a pick.
   */
  private renderChoice(): void {
    if (!this.built) return;
    const options = this.plugin.claudeOptions;
    this.modelEl.toggleClass("cw-hidden", options === undefined);
    this.effortEl.toggleClass("cw-hidden", options === undefined);
    this.taskEl.toggleClass("cw-hidden", options !== undefined);
    if (!options) return;

    const key = this.session?.id ?? NEW_CHAT;
    if (key === this.choiceKey) return;
    this.choiceKey = key;
    const choice = this.choices.get(key) ?? choiceFor(options, this.plugin.settings, this.session);

    this.modelEl.empty();
    for (const model of options.models) {
      this.modelEl.createEl("option", { text: modelLabel(options, model.id) }).value = model.id;
    }
    this.modelEl.value = choice.model;
    this.effortEl.empty();
    this.effortEl.createEl("option", { text: defaultEffortLabel(options) }).value = DEFAULT_EFFORT;
    for (const effort of options.efforts) {
      this.effortEl.createEl("option", { text: EFFORT_LABELS[effort] ?? effort }).value = effort;
    }
    this.effortEl.value = choice.effort;
  }

  private renderPicker(): void {
    this.pickerEl.empty();
    // Values are set as properties, so no option ever falls back to its text.
    this.pickerEl.createEl("option", { text: "New chat" }).value = NEW_CHAT;
    for (const session of this.sessions) {
      this.pickerEl.createEl("option", { text: label(session) }).value = session.id;
    }
    this.pickerEl.value = this.session?.id ?? NEW_CHAT;
  }

  private async renderMessages(): Promise<void> {
    const el = this.messagesEl;
    el.empty();
    if (!this.session) {
      renderEmptyState(el);
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
      if (message.context?.length) {
        renderChips(
          body.createDiv({ cls: "cw-context cw-message-context" }),
          chipsOf(message.context),
          {
            open: (chip) => void this.openChip(chip.notePath, chip.lines),
          },
        );
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

  /** Shows an error as a notice and keeps it under the messages until the next update. */
  private fail(error: unknown): void {
    const text = describeError(error);
    console.error("Claude Watcher:", error);
    new Notice(text);
    this.statusEl?.setText(text);
  }
}

/** The error text, with the request it came from when there was one. */
export function describeError(error: unknown): string {
  if (error instanceof WatcherError && error.request) return `${error.message} (${error.request})`;
  return error instanceof Error ? error.message : String(error);
}

function showBroken(el: HTMLElement, error: unknown): void {
  const box = el.createDiv({ cls: "cw-empty cw-chat-broken" });
  box.createDiv({ cls: "cw-empty-title", text: "The chat could not be shown" });
  box.createDiv({ text: describeError(error) });
  box.createDiv({
    text: "Close this tab and open the chat again. If it keeps happening, report this message.",
  });
}

/** What a new chat can do, shown until the first message is sent. */
export const EMPTY_STATE = {
  title: "New chat",
  intro: "Ask Claude anything about your notes. No note or instruction is needed.",
  tips: [
    "Type [[ or use the link buttons to point Claude at a note. Only its path is sent.",
    "When Claude needs text from a note, an approval card asks you first.",
    "Notes marked % or %% in the title are shared with Claude already.",
    "Follow-up messages continue the same chat. Pick an earlier chat from the list above.",
  ],
};

function renderEmptyState(el: HTMLElement): void {
  const box = el.createDiv({ cls: "cw-empty cw-chat-empty" });
  box.createDiv({ cls: "cw-empty-title", text: EMPTY_STATE.title });
  box.createDiv({ text: EMPTY_STATE.intro });
  const list = box.createEl("ul");
  for (const tip of EMPTY_STATE.tips) list.createEl("li", { text: tip });
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
