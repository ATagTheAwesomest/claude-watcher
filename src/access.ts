/**
 * Which notes Claude can already read, by the same rules the server uses:
 * a "%" or "%%" on the note's title or, failing that, on its nearest marked
 * folder shares the note. Everything else is private, and Claude sees it only
 * through excerpts the owner approves.
 */

import type { NoteAccess } from "./shared/types";

/** Prefix of partial excerpt files in the mirror. */
const PARTIAL_PREFIX = "[PN] ";

/** A marker is one or two percent signs standing alone at the start or end of a name. */
const MARKER = /^(%{1,2})(?=\s|$)|(?<=\s)(%{1,2})$/;

/** How much of a note Claude may see, from its vault path alone. */
export function classifyNote(notePath: string): NoteAccess {
  const parts = notePath.split("/");
  const title = parts.pop()!.replace(/\.md$/i, "");
  if (title.startsWith(PARTIAL_PREFIX)) return "private";
  const own = markerAccess(title);
  if (own !== "private") return own;
  for (let i = parts.length - 1; i >= 0; i--) {
    const access = markerAccess(parts[i]!);
    if (access !== "private") return access;
  }
  return "private";
}

/** True when Claude can read the whole note without asking. */
export function isShared(notePath: string): boolean {
  return classifyNote(notePath) !== "private";
}

function markerAccess(name: string): NoteAccess {
  const match = MARKER.exec(name.trim());
  const marker = match?.[1] ?? match?.[2];
  if (marker === "%%") return "instructions";
  if (marker === "%") return "readable";
  return "private";
}
