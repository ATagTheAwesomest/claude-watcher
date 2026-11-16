// @vitest-environment jsdom
import { EditorState, type Transaction } from "@codemirror/state";
import { WidgetType } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import {
  acceptTransaction,
  draftLines,
  minimalChange,
  pendingEdits,
  place,
  placedChanges,
  showChanges,
  type ChangeHooks,
} from "../src/pendingEdits";
import type { PendingChange } from "../src/shared/types";

const NOTE = ["# Shopping", "- 1 tbsp olive oil", "- 2 garlic cloves", "- 1 onion", "- salt"].join(
  "\n",
);

class Box extends WidgetType {
  toDOM() {
    return document.createElement("div");
  }
}

const change = (over: Partial<PendingChange>): PendingChange => ({
  id: "c1",
  notePath: "Shopping %.md",
  startLine: 3,
  endLine: 4,
  lines: ["- 3 garlic cloves", "- 1 red onion"],
  noteHash: "h",
  ...over,
});

function editor(changes: PendingChange[], text = NOTE) {
  const blocked = vi.fn();
  const hooks: ChangeHooks = { widget: () => new Box(), blocked };
  let state = EditorState.create({ doc: text, extensions: pendingEdits() });
  state = state.update({ effects: showChanges.of({ fresh: changes, keep: [], hooks }) }).state;
  return { state, blocked, hooks };
}

/** Types `text` at `at` the way a keystroke does. */
function type(state: EditorState, at: number, text: string): Transaction {
  return state.update({ changes: { from: at, insert: text }, userEvent: "input.type" });
}

function accept(state: EditorState, id: string, lines: string[]): string {
  return state.update(acceptTransaction(state, id, lines)!).state.doc.toString();
}

describe("placing a change", () => {
  it("covers the replaced lines, or sits before a line, or after the last line", () => {
    const { state } = editor([]);
    const doc = state.doc;
    expect(place(doc, change({}))).toMatchObject({
      from: doc.line(3).from,
      to: doc.line(4).to,
      replaces: true,
    });
    expect(place(doc, change({ startLine: 2, endLine: 1 }))).toMatchObject({
      from: doc.line(2).from,
      replaces: false,
      side: -1,
    });
    expect(place(doc, change({ startLine: 6, endLine: 5 }))).toMatchObject({
      from: doc.length,
      side: 1,
    });
    expect(place(doc, change({ startLine: 5, endLine: 7 }))).toBeUndefined();
  });
});

describe("accepting", () => {
  it("writes the owner's edited text in place of the replaced lines", () => {
    const { state } = editor([change({})]);
    expect(accept(state, "c1", ["- 3 garlic cloves, minced"])).toBe(
      ["# Shopping", "- 1 tbsp olive oil", "- 3 garlic cloves, minced", "- salt"].join("\n"),
    );
    expect(placedChanges(state.update(acceptTransaction(state, "c1", [])!).state)).toEqual([]);
  });

  it("removes the lines when the box is emptied, and inserts new lines where they belong", () => {
    const { state } = editor([
      change({}),
      change({ id: "c2", startLine: 2, endLine: 1, lines: ["- pepper"] }),
      change({ id: "c3", startLine: 6, endLine: 5, lines: ["", "Done"] }),
    ]);
    expect(accept(state, "c1", draftLines(""))).toBe(
      ["# Shopping", "- 1 tbsp olive oil", "- salt"].join("\n"),
    );
    expect(accept(state, "c2", ["- pepper"])).toContain("# Shopping\n- pepper\n- 1 tbsp");
    expect(accept(state, "c3", ["", "Done"])).toBe(`${NOTE}\n\nDone`);
  });

  it("follows the owner's typing elsewhere in the note", () => {
    let { state } = editor([change({}), change({ id: "c3", startLine: 6, endLine: 5 })]);
    state = type(state, 0, "Groceries\n").state;
    state = type(state, state.doc.length, "\n- pepper").state;
    expect(accept(state, "c1", ["- 3 garlic cloves"])).toBe(
      [
        "Groceries",
        "# Shopping",
        "- 1 tbsp olive oil",
        "- 3 garlic cloves",
        "- salt",
        "- pepper",
      ].join("\n"),
    );
    // Text typed at the end of the note stays before lines appended after it.
    expect(accept(state, "c3", ["Done"]).endsWith("- pepper\nDone")).toBe(true);
  });

  it("leaves the rest of the note untouched, so the cursor and other changes stay put", () => {
    expect(minimalChange("abcXYZdef", "abc12def")).toEqual({ from: 3, to: 6, insert: "12" });
    expect(minimalChange("same", "same")).toEqual({ from: 4, to: 4, insert: "" });
  });
});

describe("the replaced lines", () => {
  it("cannot be typed into while the change is pending", () => {
    const { state, blocked } = editor([change({})]);
    const inside = state.doc.line(3).from + 4;
    const result = type(state, inside, "x");
    expect(result.state.doc.toString()).toBe(NOTE);
    expect(blocked).toHaveBeenCalledOnce();

    const deleteAcross = state.update({
      changes: { from: state.doc.line(2).from, to: state.doc.line(3).from + 2 },
      userEvent: "delete.backward",
    });
    expect(deleteAcross.state.doc.toString()).toBe(NOTE);
  });

  it("lets edits outside the change, and the plugin's own edits, through", () => {
    const { state, blocked } = editor([change({})]);
    expect(type(state, 0, "x").state.doc.toString()).toBe(`x${NOTE}`);
    const plugin = state.update({ changes: { from: state.doc.line(3).from, insert: "y" } });
    expect(plugin.state.doc.line(3).text).toBe("y- 2 garlic cloves");
    expect(blocked).not.toHaveBeenCalled();
  });
});

describe("updating what is shown", () => {
  it("keeps a change where it is when its line numbers are stale, and drops one the server no longer lists", () => {
    const shown = editor([change({}), change({ id: "c2", startLine: 1, endLine: 1 })]);
    const { hooks } = shown;
    let state = shown.state;
    state = type(state, state.doc.line(2).from, "- butter\n").state;
    state = state.update({ effects: showChanges.of({ fresh: [], keep: ["c1"], hooks }) }).state;
    const placed = placedChanges(state);
    expect(placed.map((p) => p.change.id)).toEqual(["c1"]);
    expect(state.doc.sliceString(placed[0]!.from, placed[0]!.to)).toBe(
      "- 2 garlic cloves\n- 1 onion",
    );
  });
});

describe("draft lines", () => {
  it("treats an empty box as no lines", () => {
    expect(draftLines("")).toEqual([]);
    expect(draftLines("a\n\nb")).toEqual(["a", "", "b"]);
  });
});
