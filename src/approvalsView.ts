/**
 * The approval cards. Each card names a private note and the part of it Claude
 * may see. The text is read from this vault, never from the server.
 */

import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";

import { WatcherError } from "./api";
import type ClaudeWatcherPlugin from "./main";
import { RangePicker } from "./rangePicker";
import type { ApprovalRequest, NoteRange } from "./shared/types";
import { describeRange, hashNote, rangeToSpan, spanToRange } from "./text";

export const APPROVALS_VIEW = "claude-watcher-approvals";

export class ApprovalsView extends ItemView {
  private listEl!: HTMLElement;
  private readonly cards = new Map<string, HTMLElement>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ClaudeWatcherPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return APPROVALS_VIEW;
  }

  getDisplayText(): string {
    return "Claude approvals";
  }

  getIcon(): string {
    return "shield-check";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("cw-approvals");
    this.listEl = this.contentEl.createDiv();
    this.registerEvent(this.plugin.events.on("approvals", () => this.update()));
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        // A note behind a card changed: show the card again with the new text.
        for (const approval of this.plugin.approvals) {
          if (approval.notePath === file.path) this.redraw(approval);
        }
      }),
    );
    this.update();
  }

  /** Adds cards for new requests and removes settled ones, leaving the others as they are. */
  private update(): void {
    const approvals = this.plugin.approvals;
    const ids = new Set(approvals.map((approval) => approval.id));
    for (const [id, card] of this.cards) {
      if (!ids.has(id)) {
        card.remove();
        this.cards.delete(id);
      }
    }
    for (const approval of approvals) {
      if (!this.cards.has(approval.id)) this.redraw(approval);
    }
    this.listEl.toggleClass("is-empty", approvals.length === 0);
    this.listEl.querySelector(".cw-empty")?.remove();
    if (approvals.length === 0) {
      this.listEl.createDiv({ cls: "cw-empty", text: "Nothing waiting for approval." });
    }
  }

  private redraw(approval: ApprovalRequest): void {
    const old = this.cards.get(approval.id);
    const card = createDiv({ cls: "cw-card" });
    if (old) old.replaceWith(card);
    else this.listEl.appendChild(card);
    this.cards.set(approval.id, card);
    void this.fill(card, approval);
  }

  private async fill(card: HTMLElement, approval: ApprovalRequest): Promise<void> {
    const header = card.createDiv({ cls: "cw-card-header" });
    const link = header.createEl("a", { text: approval.notePath, cls: "cw-note-link" });
    link.addEventListener("click", () => void this.plugin.openNote(approval.notePath));
    card.createDiv({ cls: "cw-query", text: `Claude is looking for: ${approval.query}` });
    const rangeEl = card.createDiv({ cls: "cw-range" });

    const file = this.app.vault.getAbstractFileByPath(approval.notePath);
    if (!(file instanceof TFile)) {
      rangeEl.setText(`Proposed: ${describeRange(approval.range)}`);
      card.createDiv({
        cls: "cw-warning",
        text: "This note is not in this vault yet. Wait for sync, or reject the request.",
      });
      this.buttons(card, approval, undefined);
      return;
    }

    const text = await this.app.vault.read(file);
    const proposed = rangeToSpan(text, approval.range);
    let kind: NoteRange["kind"] = approval.range.kind;
    const showRange = () => {
      const range = spanToRange(text, picker.current, kind);
      rangeEl.setText(describeRange(range));
      return range;
    };
    const picker = new RangePicker(card, text, proposed, kind === "lines", showRange);

    const options = card.createDiv({ cls: "cw-options" });
    const wholeLines = options.createEl("label");
    const checkbox = wholeLines.createEl("input", { type: "checkbox" });
    wholeLines.appendText(" Whole lines");
    checkbox.checked = kind === "lines";
    checkbox.addEventListener("change", () => {
      kind = checkbox.checked ? "lines" : "chars";
      picker.wholeLines = checkbox.checked;
      picker.set(picker.current);
    });
    const useSelection = options.createEl("button", { text: "Use my selection" });
    useSelection.addEventListener("click", () => {
      const span = picker.textSelection();
      if (span) picker.set(span);
      else new Notice("Select some of the text above first.");
    });
    const reset = options.createEl("button", { text: "Reset" });
    reset.addEventListener("click", () => picker.set(proposed));
    showRange();

    this.buttons(card, approval, async () => {
      // The hash is of the text shown, so the server refuses if its copy differs.
      if ((await this.app.vault.read(file)) !== text) {
        new Notice("The note changed. Check the selection again.");
        this.redraw(approval);
        return undefined;
      }
      if (picker.current.end <= picker.current.start) {
        new Notice("The selection is empty. Widen it or reject the request.");
        return undefined;
      }
      return { noteHash: await hashNote(text), range: showRange() };
    });
  }

  private buttons(
    card: HTMLElement,
    approval: ApprovalRequest,
    approveBody: (() => Promise<{ noteHash: string; range: NoteRange } | undefined>) | undefined,
  ): void {
    const row = card.createDiv({ cls: "cw-buttons" });
    if (approveBody) {
      const approve = row.createEl("button", { cls: "mod-cta" });
      setIcon(approve.createSpan(), "check");
      approve.appendText(" Approve");
      approve.addEventListener("click", () =>
        this.settle(row, async () => {
          const body = await approveBody();
          if (!body) return false;
          await this.plugin.client.approve(approval.id, body);
          return true;
        }),
      );
    }
    const reject = row.createEl("button");
    setIcon(reject.createSpan(), "x");
    reject.appendText(" Reject");
    reject.addEventListener("click", () =>
      this.settle(row, async () => {
        await this.plugin.client.reject(approval.id);
        return true;
      }),
    );
  }

  /** Runs an approve or reject, then refreshes the list. */
  private async settle(row: HTMLElement, action: () => Promise<boolean>): Promise<void> {
    row.querySelectorAll("button").forEach((button) => (button.disabled = true));
    try {
      if (await action()) await this.plugin.refresh();
    } catch (error) {
      if (error instanceof WatcherError && error.code === "note_changed") {
        new Notice("The server's copy of this note is different. Wait for sync and try again.");
      } else {
        new Notice(error instanceof Error ? error.message : String(error));
      }
    } finally {
      row.querySelectorAll("button").forEach((button) => (button.disabled = false));
    }
  }
}
