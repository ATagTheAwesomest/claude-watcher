/**
 * Where Claude's pending changes sit in an editor, kept in CodeMirror state.
 *
 * A change is placed once, from the line numbers the server sent, while the
 * editor holds the note text those numbers refer to. After that its position
 * follows the owner's typing, so a change stays in place while the owner
 * edits other parts of the note, until the server numbers it again.
 *
 * The lines a change replaces cannot be edited by hand while the change is
 * pending: the owner edits Claude's proposed text instead, or rejects it.
 * This module imports nothing from Obsidian, so it can be tested alone.
 */

import {
  EditorState,
  StateEffect,
  StateField,
  type ChangeSpec,
  type Extension,
  type Range,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet, type WidgetType } from "@codemirror/view";

import type { PendingChange } from "./shared/types";
import { applyChange } from "./text";

/** A change placed in the editor. */
export interface Placed {
  change: PendingChange;
  /** Start of the first replaced line, or where new lines go. */
  from: number;
  /** End of the last replaced line. Equal to `from` when lines are only inserted. */
  to: number;
  /** Whether the change replaces lines (red) rather than only inserting some. */
  replaces: boolean;
  /** For an insertion: -1 shows it before the line at `from`, 1 after the end of the note. */
  side: -1 | 1;
}

/** What the editor needs from the rest of the plugin to draw changes. */
export interface ChangeHooks {
  widget(change: PendingChange): WidgetType;
  /** Called when the owner tries to type into lines a change replaces. */
  blocked(): void;
}

export interface ShowChanges {
  /** Changes whose note hash matches the editor text, placed from their line numbers. */
  fresh: PendingChange[];
  /** Ids of changes already shown that stay where they are, though their numbers are stale. */
  keep: string[];
  hooks: ChangeHooks;
}

interface Shown {
  placed: Placed[];
  hooks: ChangeHooks | null;
  decorations: DecorationSet;
}

export const showChanges = StateEffect.define<ShowChanges>();
export const dropChange = StateEffect.define<string>();

/** Places a change from its line numbers. Undefined when they do not fit the text. */
export function place(doc: Text, change: PendingChange): Placed | undefined {
  const { startLine, endLine } = change;
  if (startLine < 1 || endLine < startLine - 1 || endLine > doc.lines) return undefined;
  if (endLine >= startLine) {
    return {
      change,
      from: doc.line(startLine).from,
      to: doc.line(endLine).to,
      replaces: true,
      side: 1,
    };
  }
  if (startLine <= doc.lines) {
    const at = doc.line(startLine).from;
    return { change, from: at, to: at, replaces: false, side: -1 };
  }
  return { change, from: doc.length, to: doc.length, replaces: false, side: 1 };
}

export const changeField = StateField.define<Shown>({
  create: () => ({ placed: [], hooks: null, decorations: Decoration.none }),
  update(value, transaction) {
    let { placed, hooks } = value;
    let changed = false;
    if (transaction.docChanged) {
      const map = transaction.changes;
      placed = placed.map((p) => {
        if (p.replaces) return { ...p, from: map.mapPos(p.from, 1), to: map.mapPos(p.to, -1) };
        const at = map.mapPos(p.from, p.side);
        return { ...p, from: at, to: at };
      });
      changed = true;
    }
    for (const effect of transaction.effects) {
      if (effect.is(showChanges)) {
        const { fresh, keep, hooks: next } = effect.value;
        const freshIds = new Set(fresh.map((c) => c.id));
        const kept = placed.filter((p) => keep.includes(p.change.id) && !freshIds.has(p.change.id));
        const doc = transaction.state.doc;
        const added = fresh.map((c) => place(doc, c)).filter((p): p is Placed => p !== undefined);
        placed = [...kept, ...added];
        hooks = next;
        changed = true;
      } else if (effect.is(dropChange)) {
        placed = placed.filter((p) => p.change.id !== effect.value);
        changed = true;
      }
    }
    if (!changed) return value;
    // An undo can fold a replaced range over itself; such a change is no longer placed.
    placed = placed.filter((p) => p.from <= p.to);
    return { placed, hooks, decorations: decorate(transaction.state.doc, placed, hooks) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

const removedLine = Decoration.line({ class: "cw-removed-line" });
const removedText = Decoration.mark({ class: "cw-removed-text" });

function decorate(doc: Text, placed: Placed[], hooks: ChangeHooks | null): DecorationSet {
  if (!hooks) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const p of placed) {
    if (p.from > doc.length || p.to > doc.length) continue;
    if (p.replaces) {
      const first = doc.lineAt(p.from).number;
      const last = doc.lineAt(p.to).number;
      for (let n = first; n <= last; n++) {
        const line = doc.line(n);
        ranges.push(removedLine.range(line.from));
        if (line.to > line.from) ranges.push(removedText.range(line.from, line.to));
      }
    }
    const widget = Decoration.widget({ widget: hooks.widget(p.change), block: true, side: p.side });
    ranges.push(widget.range(p.replaces ? p.to : p.from));
  }
  return Decoration.set(ranges, true);
}

/** The changes placed in an editor. */
export function placedChanges(state: EditorState): Placed[] {
  return state.field(changeField, false)?.placed ?? [];
}

/**
 * The transaction that accepts a placed change with `lines` as its text.
 * Only the part of the note that differs is replaced, so the cursor and the
 * other pending changes stay where they are. Undefined when the change is not
 * placed in this editor.
 */
export function acceptTransaction(
  state: EditorState,
  id: string,
  lines: string[],
): TransactionSpec | undefined {
  const p = placedChanges(state).find((placed) => placed.change.id === id);
  if (!p) return undefined;
  const doc = state.doc;
  let startLine: number;
  let endLine: number;
  if (p.replaces) {
    startLine = doc.lineAt(p.from).number;
    endLine = doc.lineAt(p.to).number;
  } else if (p.side < 0) {
    startLine = doc.lineAt(p.from).number;
    endLine = startLine - 1;
  } else {
    startLine = doc.lines + 1;
    endLine = doc.lines;
  }
  const before = doc.toString();
  const after = applyChange(before, { ...p.change, startLine, endLine, lines });
  return {
    changes: minimalChange(before, after),
    effects: dropChange.of(id),
    userEvent: "input.accept",
  };
}

/** The single replacement that turns `before` into `after`, leaving the shared ends alone. */
export function minimalChange(before: string, after: string): ChangeSpec {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < shortest - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

/**
 * Stops the owner's typing from changing lines a pending change replaces.
 * Undo, redo and the plugin's own changes pass through.
 */
const protectReplaced = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged) return transaction;
  if (!["input", "delete", "move"].some((event) => transaction.isUserEvent(event))) {
    return transaction;
  }
  if (transaction.isUserEvent("input.accept")) return transaction;
  const shown = transaction.startState.field(changeField, false);
  if (!shown || shown.placed.length === 0) return transaction;
  let touches = false;
  transaction.changes.iterChangedRanges((fromA, toA) => {
    for (const p of shown.placed) {
      if (p.replaces && fromA <= p.to && toA >= p.from) touches = true;
    }
  });
  if (!touches) return transaction;
  shown.hooks?.blocked();
  return [];
});

/** The editor extension that shows pending changes. */
export function pendingEdits(): Extension {
  return [changeField, protectReplaced];
}

/** The lines of a text box, where an empty box means no lines at all. */
export function draftLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}
