import { describe, expect, it } from "vitest";

import { choiceFields, choiceFor, defaultEffortLabel, modelLabel } from "../src/runChoice";
import type { ChatSession, ClaudeOptions } from "../src/shared/types";

const options: ClaudeOptions = {
  models: [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  defaultModel: "sonnet",
  complexModel: "opus",
  efforts: ["low", "medium", "high", "xhigh", "max"],
};

const noDefaults = { defaultModel: "", defaultEffort: "" as const };

function session(fields: Partial<ChatSession>): ChatSession {
  return {
    id: "s1",
    status: "idle",
    messages: [],
    createdAt: "2026-11-16T10:00:00Z",
    updatedAt: "2026-11-16T10:00:00Z",
    ...fields,
  };
}

describe("the choice shown for a chat", () => {
  it("is the server's default model at the default effort without other settings", () => {
    expect(choiceFor(options, noDefaults)).toEqual({ model: "sonnet", effort: "default" });
  });

  it("follows the owner's defaults for a new chat", () => {
    const defaults = { defaultModel: "haiku", defaultEffort: "high" as const };
    expect(choiceFor(options, defaults)).toEqual({ model: "haiku", effort: "high" });
  });

  it("is what an earlier chat last ran with, over the owner's defaults", () => {
    const defaults = { defaultModel: "haiku", defaultEffort: "high" as const };
    expect(choiceFor(options, defaults, session({ model: "opus", effort: "max" }))).toEqual({
      model: "opus",
      effort: "max",
    });
    expect(choiceFor(options, defaults, session({ model: "opus" }))).toEqual({
      model: "opus",
      effort: "default",
    });
  });

  it("falls back to defaults for a chat from an older server or a model no longer offered", () => {
    const defaults = { defaultModel: "haiku", defaultEffort: "low" as const };
    expect(choiceFor(options, defaults, session({}))).toEqual({ model: "haiku", effort: "low" });
    expect(choiceFor(options, noDefaults, session({ model: "retired", effort: "low" }))).toEqual({
      model: "sonnet",
      effort: "low",
    });
    expect(choiceFor(options, { defaultModel: "retired", defaultEffort: "" }).model).toBe("sonnet");
  });
});

describe("labels", () => {
  it("mark the server's defaults", () => {
    expect(modelLabel(options, "sonnet")).toBe("Sonnet (default)");
    expect(modelLabel(options, "opus")).toBe("Opus");
    expect(defaultEffortLabel(options)).toBe("Default effort");
    expect(defaultEffortLabel({ ...options, defaultEffort: "medium" })).toBe(
      "Default effort (Medium)",
    );
  });
});

describe("what a message sends", () => {
  it("is the model and effort, or only the task size for an older server", () => {
    const choice = { model: "opus", effort: "high" as const };
    expect(choiceFields(options, choice, "simple")).toEqual({ model: "opus", effort: "high" });
    expect(choiceFields(undefined, undefined, "complex")).toEqual({ task: "complex" });
  });
});
