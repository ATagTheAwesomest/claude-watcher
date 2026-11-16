/**
 * The small button under a selection in a note: it names the selected lines
 * and adds them to the chat with one click or tap. It sits below the
 * selection, so it stays clear of the phone's own selection menu above it.
 *
 * It also tells the chat which lines are selected in the open note, so a
 * shared note's chip follows the selection.
 */

import { StateEffect, StateField, type EditorState } from "@codemirror/state";
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

/** Tells an editor to check again whether the button should show. */
export const refreshSelectionButton = StateEffect.define<null>();

/** Space between the end of the selected line and the button, in pixels. */
const GAP = 12;
/** About how wide the button is, to tell whether it fits beside the line. */
const BUTTON_WIDTH = 120;

export function selectionButton(plugin: ClaudeWatcherPlugin) {
  const tooltip = (state: EditorState): Tooltip | null => {
    // The button adds to the chat, so it shows only while the chat is open.
    if (!plugin.settings.selectionButton || !plugin.chatIsOpen()) return null;
    const lines = selectionLines(state);
    const path = notePath(state);
    if (!lines || !path) return null;
    const lineEnd = state.doc.line(lines.end).to;
    return {
      pos: lineEnd,
      above: false,
      strictSide: false,
      arrow: false,
      create: (view) => ({
        dom: buttonFor(plugin, path, lines),
        getCoords: () => beside(view, lineEnd),
      }),
    };
  };

  const field = StateField.define<Tooltip | null>({
    create: tooltip,
    update: (value, transaction) =>
      transaction.selection ||
      transaction.docChanged ||
      transaction.effects.some((effect) => effect.is(refreshSelectionButton))
        ? tooltip(transaction.state)
        : value,
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

/**
 * Where the button goes: just right of the last selected line, on that line,
 * so it covers no text. A line that runs to the edge puts it below instead.
 */
function beside(view: EditorView, lineEnd: number): DOMRect {
  const end = view.coordsAtPos(lineEnd, -1) ?? view.coordsAtPos(lineEnd, 1);
  if (!end) return new DOMRect(0, 0, 0, 0);
  const right = view.contentDOM.getBoundingClientRect().right;
  const left = end.right + GAP;
  if (left + BUTTON_WIDTH <= right) {
    // A tooltip below its position starts at the bottom of this box: the line's top.
    return new DOMRect(left, end.top, 0, 0);
  }
  return new DOMRect(end.left, end.bottom + 4, 0, 0);
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
