/**
 * The context chips above the chat's message box, and the approval step a
 * private selection goes through before Claude may see it.
 *
 * A selection of a shared note goes with the message by path and lines. A
 * selection of a private note becomes an approval request as soon as it is
 * added, shown on a card like Claude's own requests. A message that carries
 * one waits until the owner has approved or rejected it.
 *
 * "Ask Claude about this excerpt" skips the card: choosing the selection is
 * the approval of exactly that range, so the server releases it at once for
 * the chat, and removing its chip takes it back.
 */

import { Notice, setIcon } from "obsidian";

import type { TFile } from "obsidian";

import { isShared } from "./access";
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
import { hashNote, type Span } from "./text";

/** Draws the chips into `el`, each with an x to remove it. */
export function renderChips(
  el: HTMLElement,
  chips: ContextChip[],
  actions: {
    remove?: (chip: ContextChip) => void;
    open: (chip: ContextChip) => void;
    /** Which chips get an x. All of them when left out. */
    removable?: (chip: ContextChip) => boolean;
  },
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
    if (chip.state === "ended") chipEl.createSpan({ cls: "cw-chip-note", text: "ended" });
    if (actions.remove && (actions.removable?.(chip) ?? true)) {
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
  if (chip.excerpt) return chip.state === "ended" ? "shield-off" : "message-circle-question";
  if (!chip.private) return chip.lines ? "text-select" : "file-text";
  if (chip.state === "approved") return "shield-check";
  return chip.state === "waiting" ? "clock" : "lock";
}

/** The chips of a sent message, read back from the conversation. */
export function chipsOf(context: ChatContext[]): ContextChip[] {
  return context.map((item, index) => {
    const chip: ContextChip = {
      id: `${index}`,
      notePath: item.notePath,
      lines:
        item.startLine !== undefined && item.endLine !== undefined
          ? { start: item.startLine, end: item.endLine }
          : undefined,
      private: item.approvalId !== undefined,
      approvalId: item.approvalId,
      state: item.approvalId !== undefined ? "approved" : undefined,
    };
    if (item.excerpt) {
      chip.excerpt = true;
      chip.state = item.excerpt === "active" ? "approved" : "ended";
    }
    return chip;
  });
}

/** How many times, and how far apart, a refused excerpt is retried while sync catches up. */
export const EXCERPT_RETRY_MS = [1500, 3000, 6000];

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

  /**
   * Shares a selection of a note for this chat, with no approval card: the
   * owner chose it. A shared note is attached by its lines, as Claude can read
   * it already. A private note's exact characters are released for the chat,
   * once the server's copy of the note matches the text the owner sees.
   * Returns true when the selection is attached.
   */
  async ask(file: TFile, text: string, lines: LineSpan, chars: Span): Promise<boolean> {
    const what = `${describeLines(lines)} of ${file.path}`;
    const context = this.plugin.context;
    if (isShared(file.path)) {
      // Claude can read the note already, so its lines go with the message.
      context.add(file.path, lines);
      return true;
    }
    if (context.hasExcerpt(file.path, lines)) {
      new Notice(`${what} is already in the chat.`);
      return true;
    }
    const noteHash = await hashNote(text);
    const body = {
      notePath: file.path,
      range: { kind: "chars" as const, start: chars.start, end: chars.end },
      noteHash,
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const request = await this.plugin.client.shareExcerpt(body);
        context.addExcerpt(file.path, lines, request.id);
        return true;
      } catch (error) {
        const behind = error instanceof WatcherError && error.code === "note_changed";
        const wait = EXCERPT_RETRY_MS[attempt];
        if (behind && wait !== undefined) {
          if (attempt === 0) new Notice("Waiting for the server's copy of the note to catch up…");
          await sleep(wait);
          continue;
        }
        const old =
          error instanceof WatcherError &&
          error.status === 404 &&
          error.message === "No such endpoint";
        new Notice(
          old
            ? "Update the watcher server to ask Claude about a private excerpt."
            : behind
              ? `The server's copy of ${file.path} differs from yours. Wait for sync and try again.`
              : `Could not share ${what}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    }
  }

  /**
   * Removes a chip. A private selection's request is withdrawn too, and an
   * excerpt shared for the chat leaves the mirror.
   */
  async remove(chip: ContextChip): Promise<void> {
    this.plugin.context.remove(chip.id);
    if (chip.excerpt && chip.approvalId) {
      await this.withdraw(chip);
    } else if (chip.approvalId && chip.state === "waiting") {
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
   * Takes an excerpt shared for a chat back out of the mirror. Used for a
   * chip still being written and for one on a sent message. True if done.
   */
  async withdraw(chip: ContextChip): Promise<boolean> {
    try {
      await this.plugin.client.withdrawExcerpt(chip.approvalId!);
      new Notice(`${chipLabel(chip)} is no longer shared with Claude.`);
      return true;
    } catch (error) {
      new Notice(
        `Could not take back ${chipLabel(chip)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
