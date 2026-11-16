/**
 * The context chips above the chat's message box, and the approval step a
 * private selection goes through before Claude may see it.
 *
 * A selection of a shared note goes with the message by path and lines. A
 * selection of a private note becomes an approval request as soon as it is
 * added, shown on a card like Claude's own requests. A message that carries
 * one waits until the owner has approved or rejected it.
 */

import { Notice, setIcon } from "obsidian";

import { WatcherError } from "./api";
import { APPROVALS_VIEW } from "./approvalsView";
import {
  chipLabel,
  chipTitle,
  describeLines,
  type ContextChip,
  type LineSpan,
} from "./chatContext";
import type ClaudeWatcherPlugin from "./main";
import type { ChatContext } from "./shared/types";

/** Draws the chips into `el`, each with an x to remove it. */
export function renderChips(
  el: HTMLElement,
  chips: ContextChip[],
  actions: { remove?: (chip: ContextChip) => void; open: (chip: ContextChip) => void },
): void {
  el.empty();
  el.toggleClass("is-empty", chips.length === 0);
  for (const chip of chips) {
    const chipEl = el.createDiv({ cls: "cw-chip", attr: { title: chipTitle(chip) } });
    chipEl.toggleClass("is-open-note", chip.open === true);
    chipEl.toggleClass("is-private", chip.private);
    if (chip.state) chipEl.addClass(`is-${chip.state}`);
    const icon = chipEl.createSpan({ cls: "cw-chip-icon" });
    setIcon(icon, chipIcon(chip));
    const label = chipEl.createSpan({ cls: "cw-chip-label", text: chipLabel(chip) });
    label.addEventListener("click", () => actions.open(chip));
    if (chip.state === "waiting") chipEl.createSpan({ cls: "cw-chip-note", text: "approve" });
    if (actions.remove) {
      const remove = chipEl.createEl("button", {
        cls: "cw-chip-remove clickable-icon",
        attr: { "aria-label": `Remove ${chipLabel(chip)}` },
      });
      setIcon(remove, "x");
      remove.addEventListener("click", () => actions.remove!(chip));
    }
  }
}

function chipIcon(chip: ContextChip): string {
  if (chip.open) return "eye";
  if (!chip.private) return chip.lines ? "text-select" : "file-text";
  if (chip.state === "approved") return "shield-check";
  return chip.state === "waiting" ? "clock" : "lock";
}

/** The chips of a sent message, read back from the conversation. */
export function chipsOf(context: ChatContext[]): ContextChip[] {
  return context.map((item, index) => ({
    id: `${index}`,
    notePath: item.notePath,
    lines:
      item.startLine !== undefined && item.endLine !== undefined
        ? { start: item.startLine, end: item.endLine }
        : undefined,
    private: item.approvalId !== undefined,
    state: item.approvalId !== undefined ? "approved" : undefined,
  }));
}

/** Adds selections to the chat and takes private ones through approval. */
export class ContextApprovals {
  /** True while a message waits for private selections to be approved. */
  private holding = false;

  constructor(private readonly plugin: ClaudeWatcherPlugin) {}

  /** Adds a note, or some of its lines, to the next message. */
  async add(notePath: string, lines?: LineSpan): Promise<void> {
    const chip = this.plugin.context.add(notePath, lines);
    const what = lines ? `${describeLines(lines)} of ${notePath}` : notePath;
    if (!chip) {
      new Notice(`${what} is already in the chat.`);
      return;
    }
    if (!chip.private) {
      new Notice(`Added ${what} to the chat.`);
      return;
    }
    if (await this.request(chip)) {
      new Notice(`Added ${what}. Approve it before Claude sees it.`);
    }
  }

  /** Removes a chip. A private selection's request is withdrawn too. */
  async remove(chip: ContextChip): Promise<void> {
    this.plugin.context.remove(chip.id);
    if (chip.approvalId && chip.state === "waiting") {
      try {
        await this.plugin.client.reject(chip.approvalId);
        await this.plugin.refresh();
      } catch {
        // Already settled, or the server is away: the card can still be rejected.
      }
    }
    if (this.holding && this.plugin.context.waiting().length === 0) this.release();
  }

  /**
   * Readies the attached notes for sending. Returns the context to send, or
   * undefined while a private selection waits for approval; the message is
   * then sent by `onReady` once every one of them is settled.
   */
  async prepare(): Promise<ChatContext[] | undefined> {
    for (const chip of this.plugin.context.needingRequest()) await this.request(chip);
    const waiting = this.plugin.context.waiting();
    if (waiting.length === 0) return this.plugin.context.toContext();
    this.holding = true;
    new Notice(
      waiting.length === 1
        ? "Approve the private selection to send your message."
        : `Approve the ${waiting.length} private selections to send your message.`,
    );
    // The cards are where the owner approves; the message waits either way.
    await this.plugin.showView(APPROVALS_VIEW).catch((error: unknown) => {
      console.error("Claude Watcher: the approvals panel could not be shown", error);
    });
    return undefined;
  }

  /** True while a message waits for approvals. */
  get isHolding(): boolean {
    return this.holding;
  }

  /** Called after the pending approvals are fetched. Settles chips whose request was decided. */
  async check(): Promise<void> {
    const waiting = this.plugin.context.waiting();
    if (waiting.length === 0) return;
    const pending = new Set(this.plugin.approvals.map((approval) => approval.id));
    const settled = waiting.filter((chip) => !pending.has(chip.approvalId!));
    if (settled.length === 0) return;
    let all;
    try {
      all = await this.plugin.client.approvals();
    } catch {
      return; // Tried again after the next fetch.
    }
    for (const chip of settled) {
      const request = all.find((approval) => approval.id === chip.approvalId);
      if (request?.status === "approved") {
        this.plugin.context.update(chip.id, { state: "approved" });
      } else if (request?.status !== "pending") {
        this.plugin.context.remove(chip.id);
        new Notice(`${chipLabel(chip)} was rejected and is left out of the message.`);
      }
    }
    if (this.holding && this.plugin.context.waiting().length === 0) this.release();
  }

  private release(): void {
    this.holding = false;
    this.plugin.events.trigger("context-ready");
  }

  /** Asks the server for an approval request for a private selection. False if it failed. */
  private async request(chip: ContextChip): Promise<boolean> {
    const lines = chip.lines;
    try {
      const request = await this.plugin.client.shareSelection({
        notePath: chip.notePath,
        range: lines
          ? { kind: "lines", start: lines.start, end: lines.end }
          : { kind: "lines", start: 1, end: Number.MAX_SAFE_INTEGER },
      });
      this.plugin.context.update(chip.id, { approvalId: request.id, state: "waiting" });
      await this.plugin.refresh();
      return true;
    } catch (error) {
      this.plugin.context.remove(chip.id);
      const old =
        error instanceof WatcherError && error.code === "not_found" && error.status === 404;
      new Notice(
        old && error.message === "No such endpoint"
          ? "Update the watcher server to attach private selections."
          : `Could not attach ${chipLabel(chip)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
