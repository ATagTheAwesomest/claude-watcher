import { describe, expect, it } from "vitest";

import { classifyNote } from "../src/access";
import {
  ChatContextModel,
  OPEN_CHIP,
  chipLabel,
  describeLines,
  selectedLines,
} from "../src/chatContext";

describe("which notes Claude can already read", () => {
  it("follows the server's title and folder markers", () => {
    expect(classifyNote("Diary.md")).toBe("private");
    expect(classifyNote("Plan %.md")).toBe("readable");
    expect(classifyNote("Plan %%.md")).toBe("instructions");
    expect(classifyNote("Recipes %/Soup.md")).toBe("readable");
    expect(classifyNote("Work %%/Q3/Plan.md")).toBe("instructions");
    expect(classifyNote("Recipes %/Plan %%.md")).toBe("instructions");
    expect(classifyNote("Sale 50%.md")).toBe("private");
    expect(classifyNote("Shared %/[PN] Diary.md")).toBe("private");
  });
});

describe("selected lines", () => {
  it("leaves out a last line the selection only touches at its start", () => {
    expect(selectedLines(12, 18, 4)).toEqual({ start: 12, end: 18 });
    expect(selectedLines(12, 19, 0)).toEqual({ start: 12, end: 18 });
    expect(selectedLines(5, 5, 0)).toEqual({ start: 5, end: 5 });
  });

  it("are named on the button and the chip", () => {
    expect(describeLines({ start: 12, end: 18 })).toBe("Lines 12-18");
    expect(describeLines({ start: 3, end: 3 })).toBe("Line 3");
    const chip = {
      id: "x",
      notePath: "Garden/Plan %.md",
      lines: { start: 2, end: 4 },
      private: false,
    };
    expect(chipLabel(chip)).toBe("Plan %:2-4");
  });
});

describe("the chips of the next message", () => {
  it("include the open note by default when it is shared, following its selection", () => {
    const model = new ChatContextModel();
    model.setOpenNote("Plan %.md");
    expect(model.chips()).toMatchObject([{ id: OPEN_CHIP, notePath: "Plan %.md", open: true }]);
    model.setOpenNote("Plan %.md", { start: 3, end: 5 });
    expect(model.toContext()).toEqual([{ notePath: "Plan %.md", startLine: 3, endLine: 5 }]);
  });

  it("never include a private open note on their own", () => {
    const model = new ChatContextModel();
    model.setOpenNote("Diary.md", { start: 1, end: 2 });
    expect(model.chips()).toEqual([]);
    expect(model.toContext()).toEqual([]);
  });

  it("leave out the open note once removed, until another note opens", () => {
    const model = new ChatContextModel();
    model.setOpenNote("Plan %.md");
    model.remove(OPEN_CHIP);
    model.setOpenNote("Plan %.md", { start: 1, end: 1 });
    expect(model.chips()).toEqual([]);
    model.setOpenNote("Recipes %/Soup.md");
    expect(model.chips()).toHaveLength(1);
  });

  it("respect the setting that turns the open note off", () => {
    let include = true;
    const model = new ChatContextModel(() => include);
    model.setOpenNote("Plan %.md");
    include = false;
    expect(model.chips()).toEqual([]);
  });

  it("add a selection once, and send private ones only when approved", () => {
    const model = new ChatContextModel();
    const shared = model.add("Plan %.md", { start: 2, end: 4 })!;
    expect(model.add("Plan %.md", { start: 2, end: 4 })).toBeUndefined();
    const secret = model.add("Diary.md", { start: 7, end: 9 })!;
    expect(shared.private).toBe(false);
    expect(secret).toMatchObject({ private: true, state: "new" });
    expect(model.needingRequest()).toEqual([secret]);

    model.update(secret.id, { approvalId: "a1", state: "waiting" });
    expect(model.waiting()).toHaveLength(1);
    expect(model.toContext()).toEqual([{ notePath: "Plan %.md", startLine: 2, endLine: 4 }]);

    model.update(secret.id, { state: "approved" });
    expect(model.toContext()).toContainEqual({
      notePath: "Diary.md",
      startLine: 7,
      endLine: 9,
      approvalId: "a1",
    });
  });

  it("show an added selection once even when it matches the open note's", () => {
    const model = new ChatContextModel();
    model.setOpenNote("Plan %.md", { start: 2, end: 4 });
    model.add("Plan %.md", { start: 2, end: 4 });
    expect(model.chips()).toHaveLength(1);
  });

  it("keep the open note after a message is sent and clear the rest", () => {
    const model = new ChatContextModel();
    model.setOpenNote("Plan %.md");
    model.add("Other %.md");
    let changes = 0;
    model.onChange(() => changes++);
    model.clearAdded();
    expect(changes).toBe(1);
    expect(model.chips().map((chip) => chip.id)).toEqual([OPEN_CHIP]);
  });
});
