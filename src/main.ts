import { Events, Notice, debounce, Plugin, TFile, WorkspaceLeaf } from "obsidian";

import { WatcherClient } from "./api";
import { APPROVALS_VIEW, ApprovalsView } from "./approvalsView";
import { CHAT_VIEW, ChatView } from "./chatView";
import { EditReview } from "./edits";
import { instructionHighlighter } from "./instructionHighlight";
import { SYNTAX_EXAMPLES, findInstructions, hasInstructionMarker } from "./instructions";
import { DEFAULT_SETTINGS, WatcherSettingTab, type WatcherSettings } from "./settings";
import type { ApprovalRequest, InstructionSyntax, PendingChange } from "./shared/types";

export default class ClaudeWatcherPlugin extends Plugin {
  settings: WatcherSettings = { ...DEFAULT_SETTINGS };
  readonly client = new WatcherClient(() => this.settings);
  readonly review = new EditReview(this);
  /** Fires "approvals" and "changes" when those lists are updated. */
  readonly events = new Events();
  /** Requests waiting for the owner, as last fetched. */
  approvals: ApprovalRequest[] = [];
  /** Claude's edits waiting for the owner, as last fetched. */
  changes: PendingChange[] = [];
  /** The instruction syntax the server reports, which wins over the plugin setting. */
  serverSyntax: InstructionSyntax | undefined;

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
    this.addRibbonIcon("message-square", "Claude chat", () => this.showView(CHAT_VIEW));
    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.showView(CHAT_VIEW),
    });
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

    this.app.workspace.onLayoutReady(() => {
      this.startPolling();
      void this.refresh();
      void this.loadServerSyntax();
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

  /** Asks the server which instruction syntax it uses. Older servers do not say. */
  async loadServerSyntax(): Promise<void> {
    if (!this.client.configured) return;
    try {
      const syntax = (await this.client.serverSettings())?.instructions?.syntax;
      this.setServerSyntax(syntax === "angle" || syntax === "square" ? syntax : undefined);
    } catch {
      // Unreachable server: keep the plugin setting until the next try.
    }
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

  async showView(type: string): Promise<unknown> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(type)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type, active: true });
    }
    if (!leaf) return undefined;
    await workspace.revealLeaf(leaf);
    return leaf.view;
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
    const fresh = this.approvals.filter((approval) => !this.seenApprovals.has(approval.id));
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
