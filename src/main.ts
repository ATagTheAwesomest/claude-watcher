import { Events, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";

import { WatcherClient } from "./api";
import { APPROVALS_VIEW, ApprovalsView } from "./approvalsView";
import { DEFAULT_SETTINGS, WatcherSettingTab, type WatcherSettings } from "./settings";
import type { ApprovalRequest } from "./shared/types";

export default class ClaudeWatcherPlugin extends Plugin {
  settings: WatcherSettings = { ...DEFAULT_SETTINGS };
  readonly client = new WatcherClient(() => this.settings);
  /** Fires "approvals" when the list of pending requests is updated. */
  readonly events = new Events();
  /** Requests waiting for the owner, as last fetched. */
  approvals: ApprovalRequest[] = [];

  private pollTimer: number | undefined;
  private seenApprovals = new Set<string>();
  private lastError = "";

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new WatcherSettingTab(this.app, this));
    this.registerView(APPROVALS_VIEW, (leaf) => new ApprovalsView(leaf, this));

    this.addRibbonIcon("shield-check", "Claude approvals", () => this.showView(APPROVALS_VIEW));
    this.addCommand({
      id: "open-approvals",
      name: "Open approvals",
      callback: () => this.showView(APPROVALS_VIEW),
    });
    this.addCommand({
      id: "check-now",
      name: "Check for requests now",
      callback: () => void this.refresh(true),
    });

    this.app.workspace.onLayoutReady(() => {
      this.startPolling();
      void this.refresh();
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
  }

  /** Fetches what is waiting for the owner. With `loud`, errors are always shown. */
  async refresh(loud = false): Promise<void> {
    if (!this.client.configured) {
      if (loud) new Notice("Set the watcher server address and API key in the settings first.");
      return;
    }
    try {
      this.approvals = await this.client.pendingApprovals();
      this.lastError = "";
      this.events.trigger("approvals");
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

  async showView(type: string): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(type)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
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
