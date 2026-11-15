import { describe, expect, it } from "vitest";

import { findInstructions, hasInstructionMarker } from "../src/instructions";

const lines = (text: string, syntax: "angle" | "square" = "angle") =>
  findInstructions(text, syntax).map(({ startLine, endLine }) => [startLine, endLine]);

describe("findInstructions", () => {
  it("finds angle instructions in either case, across lines", () => {
    const text = "intro\n<c: one>\n<C: two\nand more>\n";
    expect(lines(text)).toEqual([
      [2, 2],
      [3, 4],
    ]);
    const [first] = findInstructions(text, "angle");
    expect(text.slice(first!.start, first!.end)).toBe("<c: one>");
  });

  it("still reads the square syntax under angle", () => {
    expect(lines("[c: old]\n<c: new>")).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("reads only square instructions under square", () => {
    expect(lines("<c: new>\n[c: see [[Link]]]", "square")).toEqual([[2, 2]]);
  });

  it("skips fenced code and unclosed instructions", () => {
    expect(lines("```\n<c: code>\n```\n<c: open")).toEqual([]);
  });
});

describe("hasInstructionMarker", () => {
  it("accepts %% at either end only", () => {
    expect(hasInstructionMarker("Plan %%")).toBe(true);
    expect(hasInstructionMarker("%% Plan")).toBe(true);
    expect(hasInstructionMarker("Plan %")).toBe(false);
    expect(hasInstructionMarker("50%% off")).toBe(false);
  });
});

describe("angle closing rules", () => {
  it("keeps arrows, escapes, tags and inline code inside", () => {
    const text = "<c: a -> b => c \\> d <b>bold</b> `x > y` <https://example.com> done>\nafter";
    const [found] = findInstructions(text, "angle");
    expect(text.slice(found!.start, found!.end)).toBe(text.split("\n")[0]);
  });
});
