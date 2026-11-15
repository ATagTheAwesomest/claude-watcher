/**
 * Tints the owner's instructions in "%%" notes, so it is clear what the
 * "Send this note's instructions to Claude" command will send.
 */

import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";
import { editorInfoField } from "obsidian";

import { findInstructions, hasInstructionMarker } from "./instructions";
import type ClaudeWatcherPlugin from "./main";

const mark = Decoration.mark({ class: "cw-instruction-mark" });

export function instructionHighlighter(plugin: ClaudeWatcherPlugin) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private syntax = plugin.instructionSyntax();

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate): void {
        const syntax = plugin.instructionSyntax();
        if (update.docChanged || syntax !== this.syntax) {
          this.syntax = syntax;
          this.decorations = this.build(update.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const file = view.state.field(editorInfoField, false)?.file;
        if (file && hasInstructionMarker(file.basename)) {
          for (const { start, end } of findInstructions(view.state.doc.toString(), this.syntax)) {
            builder.add(start, end, mark);
          }
        }
        return builder.finish();
      }
    },
    { decorations: (value) => value.decorations },
  );
}
