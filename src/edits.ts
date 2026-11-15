/**
 * Claude's pending edits: shown in the note as red (replaced) and green (new)
 * lines, each group with its own Accept and Reject buttons.
 *
 * The server never writes to the vault. Accepting a change is the only way
 * one of Claude's edits reaches a note, and it is done here, by the plugin.
 */

import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { MarkdownView, Notice, TFile, setIcon } from "obsidian";

import type ClaudeWatcherPlugin from "./main";
import type { PendingChange } from "./shared/types";
import { applyChange, hashNote } from "./text";

/** Wait this long after accepting before asking the server again, in milliseconds. */
const SETTLE_DELAY_MS = 1500;

export class EditReview {
  constructor(private readonly plugin: ClaudeWatcherPlugin) {}

  /** The editor extension that draws pending changes. */
  extension(): Extension {
    return changeField;
  }

  /** Writes a change into the vault note, if the note is still the text Claude edited. */
  async accept(change: PendingChange): Promise<void> {
    const { vault } = this.plugin.app;
    const file = vault.getAbstractFileByPath(change.notePath);
    if (!(file instanceof TFile)) {
      new Notice(`${change.notePath} is not in this vault.`);
      return;
    }
    const text = await vault.read(file);
    if ((await hashNote(text)) !== change.noteHash) {
      new Notice("The note changed since Claude's edit. Checking the edits again.");
      await this.plugin.refresh();
      return;
    }
    let applied = false;
    await vault.process(file, (current) => {
      // The note may have changed while the hash was being computed.
      if (current !== text) return current;
      applied = true;
      return applyChange(text, change);
    });
    if (!applied) {
      new Notice("The note changed while accepting. Try again.");
      await this.plugin.refresh();
      return;
    }
    // The other changes to this note now have stale line numbers. Hide them
    // until the server has seen the note change and numbered them again.
    this.plugin.changes = this.plugin.changes.filter((c) => c.notePath !== change.notePath);
    this.plugin.events.trigger("changes");
    window.setTimeout(() => void this.plugin.refresh(), SETTLE_DELAY_MS);
  }

  /** Asks the server to take the change back out of its mirror copy. */
  async reject(change: PendingChange): Promise<void> {
    await this.plugin.client.rejectChange(change.id);
    await this.plugin.refresh();
  }

  /** Adds Accept and Reject buttons for a change to an element. */
  buttons(parent: HTMLElement, change: PendingChange): HTMLElement {
    const row = parent.createDiv({ cls: "cw-buttons cw-change-buttons" });
    const action = (icon: string, text: string, run: () => Promise<void>, cta = false) => {
      const button = row.createEl("button", { cls: cta ? "mod-cta" : "" });
      setIcon(button.createSpan(), icon);
      button.appendText(` ${text}`);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        row.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          await run();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        } finally {
          row.querySelectorAll("button").forEach((b) => (b.disabled = false));
        }
      });
    };
    action("check", "Accept", () => this.accept(change), true);
    action("x", "Reject", () => this.reject(change));
    return row;
  }

  /** Shows each open note's pending changes, if the editor still holds the text they refer to. */
  async showInEditors(): Promise<void> {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const editorView = (view.editor as unknown as { cm?: EditorView }).cm;
      if (!editorView) continue;
      const path = view.file.path;
      const changes = this.plugin.changes.filter((change) => change.notePath === path);
      let shown: PendingChange[] = [];
      if (changes.length > 0) {
        const hash = await hashNote(editorView.state.doc.toString());
        shown = changes.filter((change) => change.noteHash === hash);
      }
      editorView.dispatch({ effects: setChanges.of({ changes: shown, review: this }) });
    }
  }
}

interface Shown {
  changes: PendingChange[];
  review: EditReview;
}

const setChanges = StateEffect.define<Shown>();

const changeField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setChanges)) next = build(transaction.state.doc, effect.value);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const removedLine = Decoration.line({ class: "cw-removed-line" });

function build(doc: EditorView["state"]["doc"], { changes, review }: Shown): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const change of changes) {
    const { startLine, endLine } = change;
    if (startLine < 1 || endLine > doc.lines) continue;
    const widget = (side: number) =>
      Decoration.widget({ widget: new ChangeWidget(change, review), block: true, side });
    if (endLine < startLine) {
      // Lines only inserted: show them before startLine, or after the last line.
      if (startLine <= doc.lines) ranges.push(widget(-1).range(doc.line(startLine).from));
      else ranges.push(widget(1).range(doc.length));
      continue;
    }
    for (let line = startLine; line <= endLine; line++) {
      ranges.push(removedLine.range(doc.line(line).from));
    }
    ranges.push(widget(1).range(doc.line(endLine).to));
  }
  return Decoration.set(ranges, true);
}

class ChangeWidget extends WidgetType {
  constructor(
    private readonly change: PendingChange,
    private readonly review: EditReview,
  ) {
    super();
  }

  eq(other: ChangeWidget): boolean {
    return (
      other.change.id === this.change.id &&
      other.change.noteHash === this.change.noteHash &&
      other.change.lines.join("\n") === this.change.lines.join("\n")
    );
  }

  toDOM(): HTMLElement {
    const el = createDiv({ cls: "cw-change" });
    for (const line of this.change.lines) {
      el.createDiv({ cls: "cw-added-line", text: line === "" ? " " : line });
    }
    if (this.change.lines.length === 0) {
      el.createDiv({ cls: "cw-change-label", text: "Claude removes the lines in red." });
    }
    this.review.buttons(el, this.change);
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
