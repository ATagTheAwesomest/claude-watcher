/**
 * Types shared between the watcher server and the Obsidian plugin.
 *
 * This folder must stay free of Node and Obsidian imports so it can be
 * copied into the plugin repository unchanged.
 */

/** How much of a vault note Claude is allowed to see. */
export type NoteAccess =
  /** No marker in the title. Claude only sees excerpts the owner approves. */
  | "private"
  /** One percent sign in the title. Claude may read the whole note. */
  | "readable"
  /** Two percent signs in the title. Readable, and its "<c: ...>" parts are instructions. */
  | "instructions";

/** A range of whole lines. Line numbers start at 1 and both ends are included. */
export interface LineRange {
  kind: "lines";
  start: number;
  end: number;
}

/** A range of characters. Offsets start at 0 and `end` is not included. */
export interface CharRange {
  kind: "chars";
  start: number;
  end: number;
}

/** A selection inside a note, as shown on an approval card. */
export type NoteRange = LineRange | CharRange;

/**
 * How instructions are written in a note: "angle" is "<c: ...>" (the older
 * "[c: ...]" still counts), "square" is "[c: ...]" only.
 */
export type InstructionSyntax = "angle" | "square";

/** Where one "<c: ...>" instruction sits inside a note. */
export interface InstructionLocation {
  /** First line of the instruction (the line holding the opening "<c:" or "[c:"). */
  startLine: number;
  /** Last line of the instruction. */
  endLine: number;
}

/**
 * Tells Claude where the instructions are without repeating their text.
 * Claude reads them from the mirrored note itself.
 */
export interface InstructionPointer {
  /** Note path relative to the vault root, using forward slashes. */
  notePath: string;
  instructions: InstructionLocation[];
}

/** Where an approval request stands. */
export type ApprovalStatus = "pending" | "approved" | "rejected";

/**
 * A request to show Claude part of a private note, as the plugin sees it.
 * It carries the note's path and a range but never the note's text: the
 * plugin reads the text from its own synced copy of the vault.
 */
export interface ApprovalRequest {
  id: string;
  /** Note path relative to the vault root, using forward slashes. */
  notePath: string;
  /** The proposed selection. The owner may change it before approving. */
  range: NoteRange;
  /** What Claude said it is looking for. */
  query: string;
  status: ApprovalStatus;
  /** ISO 8601 time the request was made. */
  createdAt: string;
  /** Position among the suggestions of one search, 1 being the best match. */
  rank?: number;
  /** Shared by every suggestion that came from the same request by Claude. */
  batchId?: string;
}

/** Response of `GET /approvals`. */
export interface ApprovalList {
  approvals: ApprovalRequest[];
}

/** Body of `POST /approvals/:id/approve`. */
export interface ApproveBody {
  /** The range to release. Leave out to approve the proposed range as it is. */
  range?: NoteRange;
  /**
   * SHA-256 (hex) of the note's UTF-8 text as the plugin showed it. The server
   * refuses the approval if its copy of the note differs, so a range is never
   * applied to text the owner did not see.
   */
  noteHash: string;
}

/** Body of `POST /requests`, sent by the request tool on Claude's behalf. */
export interface MoreRequestBody {
  /** What Claude is looking for, in its own words. */
  query: string;
  /** The note to look in, when Claude knows it. A "[PN] ..." mirror path also works. */
  notePath?: string;
  /** Words or short phrases to search for, chosen by Claude. */
  terms?: string[];
  /** Regular expressions to search for, matched per line and ignoring case. */
  patterns?: string[];
}

/**
 * How the server finds excerpts. "claude" searches for the terms and
 * patterns Claude sends, "keyword" for the words of its request, and
 * "ollama" also asks a local model.
 */
export type SearchMode = "claude" | "keyword" | "ollama";

/** Response of `GET /settings`. Read-only; the server's environment sets it. */
export interface ServerSettings {
  search: {
    mode: SearchMode;
    /** Most suggestions one request puts in front of the owner. */
    maxSuggestions: number;
  };
  instructions: {
    /** How the owner writes instructions in notes. */
    syntax: InstructionSyntax;
  };
}

/**
 * What Claude learns about a request. It holds no range, so Claude cannot
 * tell whether the owner changed the selection.
 */
export interface MoreRequestStatus {
  id: string;
  status: ApprovalStatus;
  /** Mirror path of the "[PN] ..." file to read once the request is approved. */
  file?: string;
}

/** How demanding a task is. It decides which Claude model runs it. */
export type TaskSize = "simple" | "complex";

/** One message in a sidebar conversation. */
export interface ChatMessage {
  role: "owner" | "claude";
  /** What was written. May be empty when the owner's message is only a pointer. */
  text: string;
  /**
   * Set when the owner's message is the "<c: ...>" instructions of a note.
   * The plugin reads their text from the vault.
   */
  pointer?: InstructionPointer;
  /** True when the run failed and `text` says why. */
  error?: boolean;
  /** ISO 8601 time. */
  at: string;
}

/** A conversation with Claude. One Claude Code session is kept open across its messages. */
export interface ChatSession {
  id: string;
  /** "running" while Claude is working on the latest message. */
  status: "running" | "idle";
  /** The note the conversation started from, if any. */
  notePath?: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

/** Response of `GET /sessions`. */
export interface ChatSessionList {
  sessions: ChatSession[];
}

/**
 * Body of `POST /sessions`. Give a note with "<c: ...>" instructions, a
 * message, or both.
 */
export interface StartSessionBody {
  notePath?: string;
  message?: string;
  /** Defaults to "simple". */
  task?: TaskSize;
}

/** Body of `POST /sessions/:id/messages`. */
export interface SessionMessageBody {
  message: string;
  /** Defaults to "simple". */
  task?: TaskSize;
}

/**
 * An edit Claude made to a note in the mirror, waiting for the owner. Nothing
 * is written to the vault by the server: on accepting, the plugin replaces the
 * lines in the vault note itself.
 *
 * Lines are the note's text split at "\n" and numbered from 1.
 */
export interface PendingChange {
  id: string;
  /** Note path relative to the vault root, using forward slashes. */
  notePath: string;
  /** First line to replace. */
  startLine: number;
  /** Last line to replace. One less than `startLine` when lines are only inserted. */
  endLine: number;
  /** The lines that take their place. Empty when lines are only removed. */
  lines: string[];
  /** SHA-256 (hex) of the note text the line numbers refer to. */
  noteHash: string;
  /** The conversation that last edited this note. */
  sessionId?: string;
}

/** Response of `GET /changes`. */
export interface PendingChangeList {
  changes: PendingChange[];
}

/** Error body returned by every endpoint. */
export interface ApiErrorBody {
  error: string;
  message: string;
}
