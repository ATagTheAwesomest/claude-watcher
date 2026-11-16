/**
 * Claude's pending edits: shown in the note as struck-through red lines (what
 * Claude replaces) and an editable green box (what Claude proposes), each with
 * its own Accept and Reject buttons.
 *
 * The owner can change the proposed text before accepting it. Those drafts
 * stay in the plugin until the change is accepted or rejected.
 *
 * The server never writes to the vault. Accepting a change is the only way
 * one of Claude's edits reaches a note, and it is done here, by the plugin.
 */

import type { Extension } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { MarkdownView, Notice, Platform, TFile, setIcon } from "obsidian";

import type ClaudeWatcherPlugin from "./main";
import {
  acceptTransaction,
  draftLines,
  pendingEdits,
  placedChanges,
  showChanges,
  type ChangeHooks,
} from "./pendingEdits";
import type { PendingChange } from "./shared/types";
import { applyChange, hashNote } from "./text";

/** Wait this long after accepting before asking the server again, in milliseconds. */
const SETTLE_DELAY_MS = 1500;

export class EditReview {
  /** The owner's edits to Claude's proposed text, by change id. */
  private readonly drafts = new Map<string, string>();
  /** Changes accepted here that the server may still list for a moment. */
  private readonly accepted = new Set<string>();
  private readonly hooks: ChangeHooks = {
    widget: (change) => new ChangeWidget(change, this),
    blocked: () =>
      new Notice("Edit Claude's proposed text in the green box, or reject the change first."),
  };

  constructor(private readonly plugin: ClaudeWatcherPlugin) {}

  /** The editor extension that draws pending changes. */
  extension(): Extension {
    return pendingEdits();
  }

  /** The text the owner wants for a change: their draft, or Claude's lines. */
  draft(change: PendingChange): string {
    return this.drafts.get(change.id) ?? change.lines.join("\n");
  }

  setDraft(change: PendingChange, text: string): void {
    if (text === change.lines.join("\n")) this.drafts.delete(change.id);
    else this.drafts.set(change.id, text);
  }

  isEdited(change: PendingChange): boolean {
    return this.drafts.has(change.id);
  }

  /** Leaves out changes accepted here that the server has not caught up with yet. */
  withoutAccepted(changes: PendingChange[]): PendingChange[] {
    const listed = new Set(changes.map((change) => change.id));
    for (const id of this.accepted) if (!listed.has(id)) this.accepted.delete(id);
    return changes.filter((change) => !this.accepted.has(change.id));
  }

  /**
   * Writes a change, with any edits the owner made to it, into the note. When
   * the note is open the change is made in the editor, where it follows the
   * owner's typing; otherwise only if the note is still the text Claude edited.
   */
  async accept(change: PendingChange): Promise<void> {
    const lines = draftLines(this.draft(change));
    for (const { view, editor } of this.editorsOf(change.notePath)) {
      const transaction = acceptTransaction(editor.state, change.id, lines);
      if (!transaction) continue;
      editor.dispatch(transaction);
      await view.save();
      this.settle(change, false);
      return;
    }

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
      return applyChange(text, { ...change, lines });
    });
    if (!applied) {
      new Notice("The note changed while accepting. Try again.");
      await this.plugin.refresh();
      return;
    }
    // The other changes to this note now have stale line numbers. Hide them
    // until the server has seen the note change and numbered them again.
    this.settle(change, true);
  }

  /** Asks the server to take the change back out of its mirror copy. */
  async reject(change: PendingChange): Promise<void> {
    await this.plugin.client.rejectChange(change.id);
    this.drafts.delete(change.id);
    await this.plugin.refresh();
  }

  /** Adds Accept and Reject buttons for a change to an element. */
  buttons(parent: HTMLElement, change: PendingChange): HTMLElement {
    const row = parent.createDiv({ cls: "cw-change-actions" });
    const action = (icon: string, text: string, cls: string, run: () => Promise<void>) => {
      const button = row.createEl("button", {
        cls: `cw-change-button ${cls}`,
        attr: { "aria-label": `${text} Claude's change` },
      });
      setIcon(button.createSpan({ cls: "cw-change-icon" }), icon);
      button.createSpan({ text });
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
    action("check", "Accept", "is-accept", () => this.accept(change));
    action("x", "Reject", "is-reject", () => this.reject(change));
    return row;
  }

  /**
   * Shows each open note's pending changes. A change is placed while the
   * editor holds the text its line numbers refer to; one already shown stays
   * where it is while the owner types, until the server numbers it again.
   */
  async showInEditors(): Promise<void> {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const editor = (view.editor as unknown as { cm?: EditorView }).cm;
      if (!editor) continue;
      const path = view.file.path;
      const changes = this.plugin.changes.filter((change) => change.notePath === path);
      const doc = editor.state.doc;
      let fresh: PendingChange[] = [];
      if (changes.length > 0) {
        const hash = await hashNote(doc.toString());
        // The owner typed while the hash was computed; the next update places them.
        if (editor.state.doc !== doc) continue;
        fresh = changes.filter((change) => change.noteHash === hash);
      }
      const shown = new Set(placedChanges(editor.state).map((p) => p.change.id));
      const keep = changes.filter((change) => shown.has(change.id)).map((change) => change.id);
      editor.dispatch({ effects: showChanges.of({ fresh, keep, hooks: this.hooks }) });
    }
  }

  private *editorsOf(notePath: string): Generator<{ view: MarkdownView; editor: EditorView }> {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== notePath) continue;
      const editor = (view.editor as unknown as { cm?: EditorView }).cm;
      if (editor) yield { view, editor };
    }
  }

  private settle(change: PendingChange, wholeNote: boolean): void {
    this.accepted.add(change.id);
    this.drafts.delete(change.id);
    this.plugin.changes = this.plugin.changes.filter((c) =>
      wholeNote ? c.notePath !== change.notePath : c.id !== change.id,
    );
    this.plugin.events.trigger("changes");
    window.setTimeout(() => void this.plugin.refresh(), SETTLE_DELAY_MS);
  }
}

/** The green box under a change: Claude's text, which the owner can edit, and the buttons. */
export class ChangeWidget extends WidgetType {
  constructor(
    readonly change: PendingChange,
    private readonly review: EditReview,
  ) {
    super();
  }

  eq(other: ChangeWidget): boolean {
    return (
      other.change.id === this.change.id &&
      other.change.lines.join("\n") === this.change.lines.join("\n")
    );
  }

  toDOM(): HTMLElement {
    const { change, review } = this;
    const removesOnly = change.lines.length === 0;
    const el = createDiv({ cls: "cw-change" });
    // A change that only removes lines shows no text box, just its buttons.
    el.toggleClass("is-removal", removesOnly);

    const box = el.createEl("textarea", {
      cls: "cw-change-text",
      attr: {
        "aria-label": "Claude's proposed text. Edit it before accepting.",
        spellcheck: "true",
        rows: "1",
        placeholder: "Empty: accepting removes the lines above.",
      },
    });
    box.value = review.draft(change);
    const fit = () => {
      box.style.height = "auto";
      box.style.height = `${box.scrollHeight}px`;
    };

    const bar = el.createDiv({ cls: "cw-change-bar" });
    const label = bar.createSpan({ cls: "cw-change-label" });
    const reset = bar.createEl("button", { cls: "cw-change-reset", text: "Undo my edits" });
    const showState = () => {
      const edited = review.isEdited(change);
      el.toggleClass("is-edited", edited);
      label.setText(
        edited
          ? "Edited"
          : removesOnly
            ? `Claude removes ${describeCount(change)}`
            : "Claude's suggestion",
      );
      reset.toggleClass("cw-hidden", !edited);
    };
    review.buttons(bar, change);
    showState();

    box.addEventListener("input", () => {
      review.setDraft(change, box.value);
      showState();
      fit();
    });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        bar.querySelector<HTMLButtonElement>(".is-accept")?.click();
      } else if (event.key === "Escape") {
        box.blur();
      }
    });
    reset.addEventListener("mousedown", (event) => event.preventDefault());
    reset.addEventListener("click", (event) => {
      event.preventDefault();
      box.value = change.lines.join("\n");
      review.setDraft(change, box.value);
      showState();
      fit();
    });
    // The height is known once the box is in the page.
    requestAnimationFrame(fit);
    if (Platform.isMobile) el.addClass("is-mobile");
    return el;
  }

  /** The editor leaves typing and clicks in the box to the box. */
  ignoreEvent(): boolean {
    return true;
  }
}

function describeCount(change: PendingChange): string {
  const count = change.endLine - change.startLine + 1;
  return count === 1 ? "this line" : `these ${count} lines`;
}
