import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../src/shared/types";
import { groupSuggestions } from "../src/suggestions";

function suggestion(
  id: string,
  query: string,
  createdAt: string,
  extra: { rank?: number; batchId?: string } = {},
): ApprovalRequest {
  return {
    id,
    notePath: `${id}.md`,
    range: { kind: "lines", start: 1, end: 2 },
    query,
    status: "pending",
    createdAt,
    ...extra,
  } as ApprovalRequest;
}

const ids = (batches: ApprovalRequest[][]) => batches.map((batch) => batch.map((a) => a.id));

describe("groupSuggestions", () => {
  it("groups by batch id and orders by rank", () => {
    const batches = groupSuggestions([
      suggestion("b", "milk", "2026-01-01T10:00:00Z", { batchId: "1", rank: 2 }),
      suggestion("a", "milk", "2026-01-01T10:00:00Z", { batchId: "1", rank: 1 }),
      suggestion("c", "milk", "2026-01-01T09:00:00Z", { batchId: "2", rank: 1 }),
    ]);
    expect(ids(batches)).toEqual([["c"], ["a", "b"]]);
  });

  it("falls back to query and time, keeping the server's order", () => {
    const batches = groupSuggestions([
      suggestion("x", "eggs", "2026-01-01T10:00:00Z"),
      suggestion("y", "eggs", "2026-01-01T10:00:00Z"),
      suggestion("z", "flour", "2026-01-01T10:00:00Z"),
    ]);
    expect(ids(batches)).toEqual([["x", "y"], ["z"]]);
  });
});
