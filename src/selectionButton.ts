/**
 * The small button under a selection in a note: it names the selected lines
 * and adds them to the chat with one click or tap. It sits below the
 * selection, so it stays clear of the phone's own selection menu above it.
 *
 * It also tells the chat which lines are selected in the open note, so a
 * shared note's chip follows the selection.
 */

import { StateField, type EditorState } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  showTooltip,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { editorInfoField, setIcon } from "obsidian";

import { describeLines, selectedLines, type LineSpan } from "./chatContext";
import type ClaudeWatcherPlugin from "./main";

/** The lines selected in an editor, or undefined when nothing is selected. */
export function selectionLines(state: EditorState): LineSpan | undefined {
  const range = state.selection.main;
  if (range.empty) return undefined;
  const from = state.doc.lineAt(range.from);
  const to = state.doc.lineAt(range.to);
  return selectedLines(from.number, to.number, range.to - to.from);
}

function notePath(state: EditorState): string | undefined {
  const file = state.field(editorInfoField, false)?.file;
  return file && file.extension === "md" ? file.path : undefined;
}

export function selectionButton(plugin: ClaudeWatcherPlugin) {
  const tooltip = (state: EditorState): Tooltip | null => {
    if (!plugin.settings.selectionButton) return null;
    const lines = selectionLines(state);
    const path = notePath(state);
    if (!lines || !path) return null;
    return {
      pos: state.selection.main.to,
      above: false,
      strictSide: false,
      arrow: false,
      create: () => ({ dom: buttonFor(plugin, path, lines) }),
    };
  };

  const field = StateField.define<Tooltip | null>({
    create: tooltip,
    update: (value, transaction) =>
      transaction.selection || transaction.docChanged ? tooltip(transaction.state) : value,
    provide: (f) => showTooltip.from(f),
  });

  const follow = ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        if (view.hasFocus) report(view);
      }
      update(update: ViewUpdate): void {
        if ((update.selectionSet || update.focusChanged) && update.view.hasFocus) {
          report(update.view);
        }
      }
    },
  );

  /** Tells the chat what the owner has selected in the note they are working in. */
  const report = (view: EditorView) => {
    const path = notePath(view.state);
    if (path) plugin.followSelection(path, selectionLines(view.state));
  };

  return [field, follow];
}

function buttonFor(plugin: ClaudeWatcherPlugin, notePath: string, lines: LineSpan): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cw-selection-button";
  const button = dom.createEl("button", {
    attr: { "aria-label": `Add ${describeLines(lines).toLowerCase()} to the Claude chat` },
  });
  button.createSpan({ cls: "cw-selection-lines", text: describeLines(lines) });
  setIcon(button.createSpan({ cls: "cw-selection-plus" }), "plus");
  // Keep the editor's focus and selection when the button is pressed.
  button.addEventListener("pointerdown", (event) => event.preventDefault());
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    void plugin.addToChat(notePath, lines);
  });
  return dom;
}
