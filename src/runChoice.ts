/**
 * Which Claude model and effort level a message runs with. The server lists
 * what it offers in `GET /settings`; older servers do not, and then the
 * plugin falls back to the simple and complex task sizes.
 */

import type { ChatSession, ClaudeOptions, EffortLevel, TaskSize } from "./shared/types";

/** The effort picker's entry for the server's default. */
export const DEFAULT_EFFORT = "default";

/** The settings that hold the owner's defaults for new chats. */
export interface ChoiceDefaults {
  /** A model id, or "" for the server's default. */
  defaultModel: string;
  /** An effort level, or "" for the server's default. */
  defaultEffort: EffortLevel | "";
}

/** What the pickers show, and what is sent. */
export interface RunChoice {
  model: string;
  effort: EffortLevel | typeof DEFAULT_EFFORT;
}

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * The choice to show for a chat: the one it last ran with, otherwise the
 * owner's defaults, otherwise the server's. A model the server no longer
 * offers is replaced by its default.
 */
export function choiceFor(
  options: ClaudeOptions,
  defaults: ChoiceDefaults,
  session?: ChatSession,
): RunChoice {
  const offered = (model: string | undefined) =>
    model !== undefined && model !== "" && options.models.some((option) => option.id === model)
      ? model
      : undefined;
  const allowed = (effort: string | undefined) =>
    effort !== undefined && (options.efforts as string[]).includes(effort)
      ? (effort as EffortLevel)
      : undefined;

  const model =
    (session ? offered(session.model) : undefined) ??
    offered(defaults.defaultModel) ??
    offered(options.defaultModel) ??
    options.models[0]?.id ??
    options.defaultModel;
  // A chat that ran at the server's default effort keeps it, rather than taking the owner's.
  const effort = session?.model
    ? (allowed(session.effort) ?? DEFAULT_EFFORT)
    : (allowed(defaults.defaultEffort) ?? DEFAULT_EFFORT);
  return { model, effort };
}

/** "Opus" or "Sonnet (default)", for pickers. */
export function modelLabel(options: ClaudeOptions, id: string): string {
  const label = options.models.find((option) => option.id === id)?.label ?? id;
  return id === options.defaultModel ? `${label} (default)` : label;
}

/** "Default effort", or "Default effort (Medium)" when the server sets one. */
export function defaultEffortLabel(options: ClaudeOptions): string {
  return options.defaultEffort
    ? `Default effort (${EFFORT_LABELS[options.defaultEffort]})`
    : "Default effort";
}

/** The fields a message carries, as `POST /sessions` and follow-ups take them. */
export function choiceFields(
  options: ClaudeOptions | undefined,
  choice: RunChoice | undefined,
  task: TaskSize,
): { model?: string; effort?: EffortLevel | "default"; task?: TaskSize } {
  if (!options || !choice) return { task };
  return { model: choice.model, effort: choice.effort };
}
