/**
 * Text helpers shared by the approval cards and the edit review. They work on
 * plain strings and import nothing from Obsidian, so they can be tested alone.
 *
 * The server and the plugin agree on these rules:
 *   - lines are the note's text split at "\n", numbered from 1, both ends included
 *   - character offsets start at 0 and the end is not included
 *   - note hashes are SHA-256 (hex) of the note's UTF-8 text
 */

import type { NoteRange, PendingChange } from "./shared/types";

/** A span of character offsets. `end` is not included. */
export interface Span {
  start: number;
  end: number;
}

/** SHA-256 (hex) of a note's text, as the server computes it. Works on desktop and mobile. */
export async function hashNote(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Offsets at which each line starts. Entry 0 is line 1. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** Converts a range to character offsets, clamped to the text, the same way the server does. */
export function rangeToSpan(text: string, range: NoteRange): Span {
  if (range.kind === "chars") {
    const start = clamp(range.start, 0, text.length);
    return { start, end: clamp(range.end, start, text.length) };
  }
  const starts = lineStarts(text);
  const start = starts[range.start - 1] ?? text.length;
  // A line range ends just before the start of the line that follows it.
  const end = starts[range.end] ?? text.length;
  return { start, end: Math.max(start, end) };
}

/** The line (from 1) that holds the character at `offset`. */
export function lineAt(text: string, offset: number): number {
  const starts = lineStarts(text);
  let line = 1;
  while (line < starts.length && starts[line]! <= offset) line++;
  return line;
}

/**
 * Converts a span back to a range. A line range covers every line the span
 * touches. An empty span gives an empty character range.
 */
export function spanToRange(text: string, span: Span, kind: NoteRange["kind"]): NoteRange {
  if (kind === "chars" || span.end <= span.start) {
    return { kind: "chars", start: span.start, end: Math.max(span.start, span.end) };
  }
  return { kind: "lines", start: lineAt(text, span.start), end: lineAt(text, span.end - 1) };
}

/** Widens a span to whole lines. The end stops before the line break of the last line. */
export function snapToLines(text: string, span: Span): Span {
  const range = spanToRange(text, span, "lines");
  if (range.kind !== "lines") return span;
  const { start, end } = rangeToSpan(text, range);
  return { start, end: text[end - 1] === "\n" ? end - 1 : end };
}

/** Describes a range for a card, such as "lines 4 to 9" or "characters 10 to 42". */
export function describeRange(range: NoteRange): string {
  if (range.kind === "lines") {
    return range.start === range.end
      ? `line ${range.start}`
      : `lines ${range.start} to ${range.end}`;
  }
  return `characters ${range.start} to ${range.end}`;
}

/** The lines a pending change replaces, from the note text its line numbers refer to. */
export function replacedLines(text: string, change: PendingChange): string[] {
  return text.split("\n").slice(change.startLine - 1, change.endLine);
}

/**
 * Applies a pending change to the note text its line numbers refer to.
 * Throws if the line numbers do not fit the text.
 */
export function applyChange(text: string, change: PendingChange): string {
  const lines = text.split("\n");
  const { startLine, endLine } = change;
  if (startLine < 1 || endLine < startLine - 1 || endLine > lines.length) {
    throw new RangeError(`Change ${change.id} does not fit the note`);
  }
  lines.splice(startLine - 1, endLine - startLine + 1, ...change.lines);
  return lines.join("\n");
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
