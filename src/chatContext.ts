/**
 * What the next chat message carries besides its text: notes, or lines of
 * notes, shown as chips above the message box. Like a code editor's chat, the
 * open note is included on its own when Claude can already read it, and a
 * selection can be added from any note. Only paths and line numbers are kept
 * here; no note text.
 *
 * This file has no Obsidian imports, so it can be tested alone.
 */

import { isShared } from "./access";
import type { ChatContext } from "./shared/types";

/** Whole lines, numbered from 1, both ends included. */
export interface LineSpan {
  start: number;
  end: number;
}

/** Where a private selection stands on its way to Claude. */
export type ChipState = "new" | "waiting" | "approved";

export interface ContextChip {
  /** Stable key: "open" for the open note, otherwise the note path and lines. */
  id: string;
  notePath: string;
  /** Leave out for the whole note. */
  lines?: LineSpan;
  /** The open note, included on its own. */
  open?: boolean;
  /** Claude cannot read this note without an approved excerpt. */
  private: boolean;
  /** For a private selection: the approval request made for it. */
  approvalId?: string;
  state?: ChipState;
}

/** The id of the chip that follows the open note. */
export const OPEN_CHIP = "open";

/**
 * The lines a selection covers. A selection that ends at the very start of a
 * line does not count that line, so selecting whole lines by dragging to the
 * next line gives the lines that look selected.
 */
export function selectedLines(fromLine: number, toLine: number, toColumn: number): LineSpan {
  const start = Math.min(fromLine, toLine);
  let end = Math.max(fromLine, toLine);
  if (end > start && toLine >= fromLine && toColumn === 0) end--;
  return { start, end };
}

/** "Line 12" or "Lines 12-18". */
export function describeLines(lines: LineSpan): string {
  return lines.start === lines.end ? `Line ${lines.start}` : `Lines ${lines.start}-${lines.end}`;
}

/** The text on a chip: the note's name, with its lines when only some are attached. */
export function chipLabel(chip: ContextChip): string {
  const name = chip.notePath.split("/").pop()!.replace(/\.md$/i, "");
  return chip.lines ? `${name}:${spanText(chip.lines)}` : name;
}

/** The longer description shown when pointing at a chip. */
export function chipTitle(chip: ContextChip): string {
  const where = chip.lines
    ? `${chip.notePath}, ${describeLines(chip.lines).toLowerCase()}`
    : chip.notePath;
  if (!chip.private) {
    return chip.open
      ? `${where} (the open note, shared with Claude)`
      : `${where} (shared with Claude)`;
  }
  if (chip.state === "approved") return `${where} (approved excerpt)`;
  return `${where} (private: Claude sees it only after you approve it)`;
}

function spanText(lines: LineSpan): string {
  return lines.start === lines.end ? `${lines.start}` : `${lines.start}-${lines.end}`;
}

function chipId(notePath: string, lines?: LineSpan): string {
  return lines ? `${notePath}#${lines.start}-${lines.end}` : notePath;
}

/** The chips of the message being written, and the open note they start with. */
export class ChatContextModel {
  private added: ContextChip[] = [];
  private openNote: { notePath: string; lines?: LineSpan } | undefined;
  /** The open note the owner removed. It stays out until another note is opened. */
  private dismissed: string | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    /** Whether the open shared note is included on its own. */
    private readonly includeOpenNote: () => boolean = () => true,
  ) {}

  /** Calls `listener` after every change. Returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The chips to show, the open note first. */
  chips(): ContextChip[] {
    const open = this.openChip();
    return open ? [open, ...this.added] : [...this.added];
  }

  /**
   * Follows the note the owner is looking at and the lines selected in it.
   * Opening another note brings back the open-note chip if it was removed.
   */
  setOpenNote(notePath: string | undefined, lines?: LineSpan): void {
    if (notePath !== this.openNote?.notePath) this.dismissed = undefined;
    const before = this.openNote;
    this.openNote = notePath === undefined ? undefined : { notePath, lines };
    if (
      before?.notePath !== notePath ||
      before?.lines?.start !== lines?.start ||
      before?.lines?.end !== lines?.end
    ) {
      this.changed();
    }
  }

  /** Adds a note or some of its lines. Returns undefined if it is already there. */
  add(notePath: string, lines?: LineSpan): ContextChip | undefined {
    const id = chipId(notePath, lines);
    if (this.added.some((chip) => chip.id === id)) return undefined;
    const chip: ContextChip = { id, notePath, lines, private: !isShared(notePath) };
    if (chip.private) chip.state = "new";
    this.added.push(chip);
    this.changed();
    return chip;
  }

  get(id: string): ContextChip | undefined {
    return this.chips().find((chip) => chip.id === id);
  }

  /** Removes a chip. Removing the open note keeps it out until another note opens. */
  remove(id: string): ContextChip | undefined {
    if (id === OPEN_CHIP) {
      const open = this.openChip();
      this.dismissed = this.openNote?.notePath;
      if (open) this.changed();
      return open;
    }
    const chip = this.added.find((candidate) => candidate.id === id);
    if (!chip) return undefined;
    this.added = this.added.filter((candidate) => candidate !== chip);
    this.changed();
    return chip;
  }

  update(id: string, change: Partial<Pick<ContextChip, "approvalId" | "state">>): void {
    const chip = this.added.find((candidate) => candidate.id === id);
    if (!chip) return;
    Object.assign(chip, change);
    this.changed();
  }

  /** Private selections that still need an approval request. */
  needingRequest(): ContextChip[] {
    return this.added.filter((chip) => chip.private && !chip.approvalId);
  }

  /** Private selections waiting for the owner's approval. */
  waiting(): ContextChip[] {
    return this.added.filter((chip) => chip.private && chip.state === "waiting");
  }

  /**
   * What goes to the server with the message. A private selection goes only
   * once approved, and then by its request alone.
   */
  toContext(): ChatContext[] {
    const context: ChatContext[] = [];
    for (const chip of this.chips()) {
      if (chip.private && chip.state !== "approved") continue;
      const item: ChatContext = { notePath: chip.notePath };
      if (chip.lines) {
        item.startLine = chip.lines.start;
        item.endLine = chip.lines.end;
      }
      if (chip.approvalId) item.approvalId = chip.approvalId;
      context.push(item);
    }
    return context;
  }

  /** Redraws after a setting that changes the chips. */
  refresh(): void {
    this.changed();
  }

  /** Clears what was added for the message just sent. The open note stays. */
  clearAdded(): void {
    if (this.added.length === 0) return;
    this.added = [];
    this.changed();
  }

  private openChip(): ContextChip | undefined {
    const note = this.openNote;
    if (!note || !this.includeOpenNote() || this.dismissed === note.notePath) return undefined;
    // Only a note Claude can already read is included without asking.
    if (!isShared(note.notePath)) return undefined;
    // An added chip for the same lines already says it.
    if (this.added.some((chip) => chip.id === chipId(note.notePath, note.lines))) return undefined;
    return {
      id: OPEN_CHIP,
      notePath: note.notePath,
      lines: note.lines,
      open: true,
      private: false,
    };
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
