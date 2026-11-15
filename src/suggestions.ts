/** Orders the suggestions the server makes for one of Claude's requests. */

import type { ApprovalRequest } from "./shared/types";

/** A suggestion may carry its place among the suggestions of one request. */
export type Suggestion = ApprovalRequest & { rank?: number; batchId?: string };

/**
 * Groups the suggestions made for one request, oldest request first and best
 * suggestion first. Without a batch id, suggestions with the same query and
 * time belong together, in the order the server listed them.
 */
export function groupSuggestions(approvals: ApprovalRequest[]): ApprovalRequest[][] {
  const batches = new Map<string, Suggestion[]>();
  for (const approval of approvals as Suggestion[]) {
    const key = approval.batchId ?? `${approval.createdAt}\0${approval.query}`;
    const batch = batches.get(key) ?? [];
    batch.push(approval);
    batches.set(key, batch);
  }
  const unranked = Number.MAX_SAFE_INTEGER;
  return [...batches.values()]
    .map((batch) => batch.sort((a, b) => (a.rank ?? unranked) - (b.rank ?? unranked)))
    .sort((a, b) => a[0]!.createdAt.localeCompare(b[0]!.createdAt));
}
