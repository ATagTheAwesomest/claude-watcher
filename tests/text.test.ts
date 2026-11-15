import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { PendingChange } from "../src/shared/types";
import {
  applyChange,
  describeRange,
  hashNote,
  lineAt,
  rangeToSpan,
  replacedLines,
  snapToLines,
  spanToRange,
} from "../src/text";

const note = "# Shopping\nMilk\nEggs\nFlour\n";

function change(startLine: number, endLine: number, lines: string[]): PendingChange {
  return { id: "c1", notePath: "Shopping %.md", startLine, endLine, lines, noteHash: "" };
}

describe("hashNote", () => {
  it("matches the server's SHA-256 of the UTF-8 text", async () => {
    const text = "Café ☕\r\nline two";
    const expected = createHash("sha256").update(text, "utf8").digest("hex");
    expect(await hashNote(text)).toBe(expected);
  });
});

describe("ranges", () => {
  it("turns a line range into the text of those lines", () => {
    const span = rangeToSpan(note, { kind: "lines", start: 2, end: 3 });
    expect(note.slice(span.start, span.end)).toBe("Milk\nEggs\n");
  });

  it("clamps ranges to the text", () => {
    expect(rangeToSpan(note, { kind: "chars", start: 20, end: 99 })).toEqual({
      start: 20,
      end: note.length,
    });
    expect(rangeToSpan(note, { kind: "lines", start: 9, end: 12 })).toEqual({
      start: note.length,
      end: note.length,
    });
  });

  it("finds the line of an offset", () => {
    expect(lineAt(note, 0)).toBe(1);
    expect(lineAt(note, 11)).toBe(2);
    expect(lineAt(note, 10)).toBe(1);
  });

  it("converts spans back to the lines they touch", () => {
    // From the middle of "Milk" to the middle of "Eggs".
    expect(spanToRange(note, { start: 13, end: 18 }, "lines")).toEqual({
      kind: "lines",
      start: 2,
      end: 3,
    });
    // A span that ends right after a line break does not take in the next line.
    expect(spanToRange(note, { start: 11, end: 16 }, "lines")).toEqual({
      kind: "lines",
      start: 2,
      end: 2,
    });
    expect(spanToRange(note, { start: 13, end: 18 }, "chars")).toEqual({
      kind: "chars",
      start: 13,
      end: 18,
    });
  });

  it("round-trips a line range", () => {
    const range = { kind: "lines" as const, start: 2, end: 4 };
    expect(spanToRange(note, rangeToSpan(note, range), "lines")).toEqual(range);
  });

  it("snaps a span to whole lines without the last line break", () => {
    const span = snapToLines(note, { start: 13, end: 18 });
    expect(note.slice(span.start, span.end)).toBe("Milk\nEggs");
  });

  it("describes ranges", () => {
    expect(describeRange({ kind: "lines", start: 4, end: 4 })).toBe("line 4");
    expect(describeRange({ kind: "lines", start: 4, end: 9 })).toBe("lines 4 to 9");
    expect(describeRange({ kind: "chars", start: 1, end: 5 })).toBe("characters 1 to 5");
  });
});

describe("applyChange", () => {
  it("replaces lines", () => {
    expect(applyChange(note, change(2, 3, ["Oat milk"]))).toBe("# Shopping\nOat milk\nFlour\n");
  });

  it("inserts lines before startLine when endLine is one less", () => {
    expect(applyChange(note, change(2, 1, ["Bread"]))).toBe(
      "# Shopping\nBread\nMilk\nEggs\nFlour\n",
    );
  });

  it("removes lines", () => {
    expect(applyChange(note, change(3, 3, []))).toBe("# Shopping\nMilk\nFlour\n");
  });

  it("appends at the end", () => {
    expect(applyChange("a\nb", change(3, 2, ["c"]))).toBe("a\nb\nc");
  });

  it("refuses line numbers outside the note", () => {
    expect(() => applyChange("a\nb", change(2, 5, []))).toThrow(RangeError);
  });

  it("lists the replaced lines", () => {
    expect(replacedLines(note, change(2, 3, []))).toEqual(["Milk", "Eggs"]);
    expect(replacedLines(note, change(2, 1, ["x"]))).toEqual([]);
  });
});
