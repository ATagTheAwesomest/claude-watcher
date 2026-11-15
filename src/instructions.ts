/**
 * Finds the owner's instructions inside a "%%" note, using the same rules as
 * the server. Imports nothing from Obsidian, so it can be tested alone.
 *
 *   angle  (default)  <c: summarise this note>   "[c: ...]" is still recognised
 *   square            [c: summarise this note]
 *
 * The letter c may be upper or lower case, an instruction may span several
 * lines, and it ends at the bracket that matches its opening one:
 *   - "[c: ...]" allows brackets inside, such as [[links]].
 *   - "<c: ...>" allows tags and autolinks inside. Arrows ("->", "=>") and an
 *     escaped "\>" do not close it.
 * Fenced code blocks and inline code are skipped, and an instruction that is
 * never closed is ignored.
 */

import type { InstructionSyntax } from "./shared/types";

/** One instruction: character offsets (end not included) and lines (from 1, both ends included). */
export interface FoundInstruction {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

const BRACKETS = { angle: ["<", ">"], square: ["[", "]"] } as const;

/** How an instruction looks in each syntax, for messages and settings. */
export const SYNTAX_EXAMPLES: Record<InstructionSyntax, string> = {
  angle: "<c: ...>",
  square: "[c: ...]",
};

/** A marker is one or two percent signs standing alone at the start or end of the title. */
const TITLE_MARKER = /^(%{1,2})(?=\s|$)|(?<=\s)(%{1,2})$/;

/** True for a title marked "%%", whose instructions Claude acts on. */
export function hasInstructionMarker(title: string): boolean {
  const match = TITLE_MARKER.exec(title.trim());
  return (match?.[1] ?? match?.[2]) === "%%";
}

/** Finds the instructions in a note's text, in order. */
export function findInstructions(content: string, syntax: InstructionSyntax): FoundInstruction[] {
  const text = blankOutInlineCode(blankOutCodeBlocks(content));
  // The angle syntax also accepts the older square one.
  const kinds = syntax === "angle" ? (["angle", "square"] as const) : (["square"] as const);
  const opening = new RegExp(kinds.map((kind) => `\\${BRACKETS[kind][0]}c:`).join("|"), "gi");

  const found: FoundInstruction[] = [];
  let line = 1;
  let position = 0;
  const advanceTo = (target: number) => {
    for (; position < target; position++) {
      if (text[position] === "\n") line++;
    }
  };

  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    const start = match.index;
    const close = findClosing(text, start);
    if (close === -1) break;
    advanceTo(start);
    const startLine = line;
    advanceTo(close + 1);
    found.push({ start, end: close + 1, startLine, endLine: line });
    opening.lastIndex = close + 1;
  }
  return found;
}

/** Returns the index of the bracket that closes the one at `open`, or -1. */
function findClosing(text: string, open: number): number {
  const angle = text[open] === "<";
  let depth = 1;
  for (let i = open + 1; i < text.length; i++) {
    const char = text[i];
    if (angle) {
      // "<" before a letter, "/" or "!" opens a nested tag or autolink.
      if (char === "<" && /[A-Za-z/!]/.test(text[i + 1] ?? "")) depth++;
      if (char === ">" && !/[-=\\]/.test(text[i - 1] ?? "") && --depth === 0) return i;
    } else {
      if (char === "[") depth++;
      if (char === "]" && --depth === 0) return i;
    }
  }
  return -1;
}

/** Replaces `inline code` with spaces, keeping offsets intact. */
function blankOutInlineCode(text: string): string {
  return text.replace(/(`+)[^`\n]*?\1/g, (span) => " ".repeat(span.length));
}

/** Replaces fenced code blocks with spaces, keeping offsets and line numbers intact. */
function blankOutCodeBlocks(content: string): string {
  let inCodeBlock = false;
  return content
    .split("\n")
    .map((line) => {
      const isFence = /^\s*(```|~~~)/.test(line);
      if (isFence) inCodeBlock = !inCodeBlock;
      return isFence || inCodeBlock ? " ".repeat(line.length) : line;
    })
    .join("\n");
}
