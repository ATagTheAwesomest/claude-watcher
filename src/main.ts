import {
  Events,
  MarkdownView,
  Notice,
  Platform,
  debounce,
  Plugin,
  TFile,
  WorkspaceLeaf,
  type Editor,
} from "obsidian";

import { WatcherClient } from "./api";
import { APPROVALS_VIEW, ApprovalsView } from "./approvalsView";
import { ChatContextModel, selectedLines, type LineSpan } from "./chatContext";
import { CHAT_VIEW, ChatView } from "./chatView";
import { ContextApprovals } from "./contextBar";
import { EditReview } from "./edits";
import { instructionHighlighter } from "./instructionHighlight";
import { SYNTAX_EXAMPLES, findInstructions, hasInstructionMarker } from "./instructions";
import { selectionButton } from "./selectionButton";
import { DEFAULT_SETTINGS, WatcherSettingTab, type WatcherSettings } from "./settings";
import type {
  ApprovalRequest,
  ClaudeOptions,
  InstructionSyntax,
  PendingChange,
} from "./shared/types";

export default class ClaudeWatcherPlugin extends Plugin {
  settings: WatcherSettings = { ...DEFAULT_SETTINGS };
  readonly client = new WatcherClient(() => this.settings);
  readonly review = new EditReview(this);
  /** Fires "approvals" and "changes" when those lists are updated, "claude-options" when the server's models change. */
  readonly events = new Events();
  /** Requests waiting for the owner, as last fetched. */
  approvals: ApprovalRequest[] = [];
  /** Claude's edits waiting for the owner, as last fetched. */
  changes: PendingChange[] = [];
  /** Notes and selections attached to the next chat message. */
  readonly context = new ChatContextModel(() => this.settings.includeOpenNote);
  readonly contextApprovals = new ContextApprovals(this);
  /** The instruction syntax the server reports, which wins over the plugin setting. */
  serverSyntax: InstructionSyntax | undefined;
  /** The models and effort levels the server offers. Older servers do not say. */
  claudeOptions: ClaudeOptions | undefined;

  private pollTimer: number | undefined;
  private seenApprovals = new Set<string>();
  private lastError = "";

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new WatcherSettingTab(this.app, this));
    this.registerView(APPROVALS_VIEW, (leaf) => new ApprovalsView(leaf, this));
    this.registerView(CHAT_VIEW, (leaf) => new ChatView(leaf, this));

    this.registerEditorExtension(this.review.extension());
    this.registerEditorExtension(instructionHighlighter(this));
    this.registerEditorExtension(selectionButton(this));
    this.registerSelectionCommands();
    // Wait a moment after a note opens, so the editor holds its text.
    const showEdits = debounce(() => void this.review.showInEditors(), 300, true);
    this.registerEvent(this.events.on("changes", showEdits));
    this.registerEvent(this.app.workspace.on("layout-change", showEdits));
    this.registerEvent(this.app.workspace.on("file-open", showEdits));

    this.addRibbonIcon("shield-check", "Claude approvals", () => this.showView(APPROVALS_VIEW));
    this.addCommand({
      id: "open-approvals",
      name: "Open approvals",
      callback: () => this.showView(APPROVALS_VIEW),
    });
    // A new chat needs no note and no instructions; one can be opened from anywhere.
    this.addRibbonIcon("message-square-plus", "New Claude chat", () => void this.newChat());
    this.addCommand({
      id: "new-chat",
      name: "New chat",
      icon: "message-square-plus",
      callback: () => void this.newChat(),
    });
    this.addCommand({
      id: "new-chat-about-note",
      name: "New chat about this note",
      icon: "message-square-plus",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.newChat(file);
        return true;
      },
    });
    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      icon: "message-square",
      callback: () => this.showView(CHAT_VIEW),
    });
    // The note menus ("..." on a phone, right click on a desktop).
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) =>
            item
              .setTitle("New Claude chat about this note")
              .setIcon("message-square-plus")
              .onClick(() => void this.newChat(file)),
          );
        }
      }),
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, _editor, info) => {
        const file = info.file;
        if (file && file.extension === "md") {
          menu.addItem((item) =>
            item
              .setTitle("New Claude chat about this note")
              .setIcon("message-square-plus")
              .onClick(() => void this.newChat(file)),
          );
        }
      }),
    );
    this.addCommand({
      id: "send-instructions",
      name: "Send this note's instructions to Claude",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        // Only "%%" notes carry instructions; the server checks the marker too.
        if (!file || file.extension !== "md" || !hasInstructionMarker(file.basename)) {
          return false;
        }
        if (!checking) void this.sendInstructions(file);
        return true;
      },
    });
    this.addCommand({
      id: "check-now",
      name: "Check for requests now",
      callback: () => void this.refresh(true),
    });

    // Sidebar views restored at startup may wait to load until shown. Load ours
    // when they are switched to, which the mobile sidebar does not always do.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf && [CHAT_VIEW, APPROVALS_VIEW].includes(leaf.view.getViewType())) {
          void leaf.loadIfDeferred?.();
        }
      }),
    );

    this.app.workspace.onLayoutReady(() => {
      for (const type of [CHAT_VIEW, APPROVALS_VIEW]) {
        for (const leaf of this.app.workspace.getLeavesOfType(type)) void leaf.loadIfDeferred?.();
      }
      this.followOpenNote(this.app.workspace.getActiveFile());
      this.registerEvent(this.app.workspace.on("file-open", (file) => this.followOpenNote(file)));
      this.startPolling();
      void this.refresh();
      void this.loadServerSettings();
    });
  }

  onunload(): void {
    window.clearInterval(this.pollTimer);
  }

  async loadSettings(): Promise<void> {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...((await this.loadData()) as Partial<WatcherSettings>),
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.startPolling();
    this.app.workspace.updateOptions();
  }

  /** The syntax in use: the server's when it reports one, otherwise the plugin setting. */
  instructionSyntax(): InstructionSyntax {
    return this.serverSyntax ?? this.settings.instructionSyntax;
  }

  /**
   * Asks the server which instruction syntax it uses and which models it
   * offers. Older servers do not say.
   */
  async loadServerSettings(): Promise<void> {
    if (!this.client.configured) return;
    try {
      const settings = await this.client.serverSettings();
      const syntax = settings?.instructions?.syntax;
      this.setServerSyntax(syntax === "angle" || syntax === "square" ? syntax : undefined);
      this.setClaudeOptions(settings?.claude);
    } catch {
      // Unreachable server: keep what is known until the next try.
    }
  }

  setClaudeOptions(options: ClaudeOptions | undefined): void {
    const valid = options && Array.isArray(options.models) && options.models.length > 0;
    const next = valid ? options : undefined;
    if (JSON.stringify(next) === JSON.stringify(this.claudeOptions)) return;
    this.claudeOptions = next;
    this.events.trigger("claude-options");
  }

  setServerSyntax(syntax: InstructionSyntax | undefined): void {
    if (syntax === this.serverSyntax) return;
    this.serverSyntax = syntax;
    this.app.workspace.updateOptions();
  }

  /** Fetches what is waiting for the owner. With `loud`, errors are always shown. */
  async refresh(loud = false): Promise<void> {
    if (!this.client.configured) {
      if (loud) new Notice("Set the watcher server address and API key in the settings first.");
      return;
    }
    try {
      [this.approvals, this.changes] = await Promise.all([
        this.client.pendingApprovals(),
        this.client.pendingChanges(),
      ]);
      this.lastError = "";
      this.events.trigger("approvals");
      this.events.trigger("changes");
      this.announceNewApprovals();
      void this.contextApprovals.check();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Repeating the same error every few seconds would only be noise.
      if (loud || message !== this.lastError) new Notice(message);
      this.lastError = message;
    }
  }

  /** Opens a note, and selects a line range in it when one is given. */
  async openNote(notePath: string, lines?: { start: number; end: number }): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) {
      new Notice(`${notePath} is not in this vault.`);
      return;
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, lines ? { eState: { line: lines.start - 1 } } : undefined);
    const editor = this.app.workspace.activeEditor?.editor;
    if (editor && lines) {
      const last = Math.min(Math.max(lines.end, lines.start), editor.lineCount()) - 1;
      const from = { line: lines.start - 1, ch: 0 };
      editor.setSelection(from, { line: last, ch: editor.getLine(last).length });
      editor.scrollIntoView({ from, to: from }, true);
    }
  }

  /** Moves a note's instructions into the chat as the owner's message. */
  async sendInstructions(file: TFile): Promise<void> {
    const syntax = this.instructionSyntax();
    if (findInstructions(await this.app.vault.cachedRead(file), syntax).length === 0) {
      new Notice(`No ${SYNTAX_EXAMPLES[syntax]} instructions in this note.`);
      return;
    }
    const view = await this.showView(CHAT_VIEW);
    if (view instanceof ChatView) await view.startFromNote(file);
  }

  /**
   * Adds a note, or some of its lines, to the next chat message. On a desktop
   * the chat is shown too; on a phone the note stays in view, so several
   * selections can be added before switching to the chat.
   */
  async addToChat(notePath: string, lines?: LineSpan): Promise<void> {
    await this.contextApprovals.add(notePath, lines);
    if (!Platform.isPhone) await this.showView(CHAT_VIEW);
  }

  /**
   * "Ask Claude about this excerpt": shares exactly the selected text for
   * this chat, with no approval card, since choosing it is the approval. The
   * chat opens with the excerpt attached, ready for a question.
   */
  async askAboutSelection(editor: Editor, file: TFile): Promise<void> {
    const lines = editorLines(editor);
    if (!lines) {
      new Notice("Select some text first.");
      return;
    }
    // Saved first, so the server's copy can match the text on screen.
    await this.app.workspace.getActiveViewOfType(MarkdownView)?.save();
    const text = editor.getValue();
    const chars = {
      start: editor.posToOffset(editor.getCursor("from")),
      end: editor.posToOffset(editor.getCursor("to")),
    };
    if (!(await this.contextApprovals.ask(file, text, lines, chars))) return;
    const view = await this.showView(CHAT_VIEW);
    if (view instanceof ChatView) view.readyForQuestion();
  }

  /** Follows the lines selected in the note the owner is working in. */
  followSelection(notePath: string, lines: LineSpan | undefined): void {
    this.context.setOpenNote(notePath, lines);
  }

  private followOpenNote(file: TFile | null): void {
    this.context.setOpenNote(file && file.extension === "md" ? file.path : undefined);
  }

  /** The commands and note-menu entries that add the selection, for phones and keyboards. */
  private registerSelectionCommands(): void {
    this.addCommand({
      id: "ask-about-selection",
      name: "Ask Claude about this excerpt",
      icon: "message-circle-question",
      editorCheckCallback: (checking, editor, info) => {
        const file = info.file;
        if (!file || file.extension !== "md" || !editor.somethingSelected()) return false;
        if (!checking) void this.askAboutSelection(editor, file);
        return true;
      },
    });
    this.addCommand({
      id: "add-selection-to-chat",
      name: "Add selection to chat",
      icon: "text-select",
      editorCheckCallback: (checking, editor, info) => {
        const file = info.file;
        if (!file || file.extension !== "md") return false;
        const lines = editorLines(editor);
        if (!checking) void this.addToChat(file.path, lines);
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const file = info.file;
        const lines = editorLines(editor);
        if (!file || file.extension !== "md" || !lines) return;
        menu.addItem((item) =>
          item
            .setTitle("Ask Claude about this excerpt")
            .setIcon("message-circle-question")
            .onClick(() => void this.askAboutSelection(editor, file)),
        );
        menu.addItem((item) =>
          item
            .setTitle(
              `Add ${lines.start === lines.end ? `line ${lines.start}` : `lines ${lines.start}-${lines.end}`} to Claude chat`,
            )
            .setIcon("text-select")
            .onClick(() => void this.addToChat(file.path, lines)),
        );
      }),
    );
  }

  /** Opens the chat on an empty conversation, with a link to `about` when given. */
  async newChat(about?: TFile): Promise<void> {
    const view = await this.showView(CHAT_VIEW);
    if (view instanceof ChatView) view.newChat(about);
    else new Notice("The chat panel could not be opened. Close its tab and try again.");
  }

  async showView(type: string): Promise<unknown> {
    const leaf = await this.leafFor(type);
    if (!leaf) return undefined;
    // Load first, so the tab is never revealed while it is still empty.
    await leaf.loadIfDeferred?.();
    await this.app.workspace.revealLeaf(leaf);
    await leaf.loadIfDeferred?.();
    return leaf.view;
  }

  /**
   * The leaf that shows a view: the right sidebar, which is the drawer on a
   * phone. A chat tab in the main area, left by an earlier version, is closed,
   * because on iOS it showed only a black screen.
   */
  private async leafFor(type: string): Promise<WorkspaceLeaf | null> {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(type).filter((leaf) => {
      if (leaf.getRoot() !== workspace.rootSplit) return true;
      leaf.detach();
      return false;
    });
    if (leaves[0]) return leaves[0];
    const leaf = workspace.getRightLeaf(false);
    await leaf?.setViewState({ type, active: true });
    return leaf;
  }

  private startPolling(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(
      () => void this.refresh(),
      Math.max(5, this.settings.pollSeconds) * 1000,
    );
    this.registerInterval(this.pollTimer);
  }

  private announceNewApprovals(): void {
    const fresh = this.approvals.filter(
      // The owner's own selections are announced when they are added.
      (approval) => !this.seenApprovals.has(approval.id) && approval.source !== "owner",
    );
    this.seenApprovals = new Set(this.approvals.map((approval) => approval.id));
    if (fresh.length === 0) return;
    const notice = new Notice(
      fresh.length === 1
        ? `Claude asks to see part of ${fresh[0]!.notePath}. Click to review.`
        : `Claude asks to see parts of ${fresh.length} notes. Click to review.`,
      10000,
    );
    notice.noticeEl.addEventListener("click", () => void this.showView(APPROVALS_VIEW));
  }
}

/** The lines selected in an Obsidian editor, or undefined when nothing is. */
function editorLines(editor: Editor): LineSpan | undefined {
  if (!editor.somethingSelected()) return undefined;
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  return selectedLines(from.line + 1, to.line + 1, to.ch);
}
