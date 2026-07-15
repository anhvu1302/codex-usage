import { describe, expect, it } from "vitest";

import { turnFiltersFromSearch, updateTurnSearch } from "@/web/lib/turns-api";

describe("turn URL filters", () => {
  it("parses shared and turn-specific filters with bounded defaults", () => {
    const filters = turnFiltersFromSearch(
      new URLSearchParams(
        "from=2026-07-01&to=2026-07-12&models=gpt-a,gpt-b,gpt-a&project=alpha&agentKind=subagent&q=needle&effort=high&session=session-a&agent=agent-a&status=aborted&pressure=85-94&sort=context&order=asc&page=2&pageSize=50",
      ),
    );

    expect(filters).toMatchObject({
      agentId: "agent-a",
      agentKind: "subagent",
      effort: "high",
      from: "2026-07-01",
      models: ["gpt-a", "gpt-b"],
      order: "asc",
      page: 2,
      pageSize: 50,
      pressure: "85-94",
      projectId: "alpha",
      query: "needle",
      sessionId: "session-a",
      sort: "context",
      status: "aborted",
      to: "2026-07-12",
    });
  });

  it("falls back safely for invalid advanced values", () => {
    expect(
      turnFiltersFromSearch(
        new URLSearchParams(
          "status=running&pressure=99&sort=unknown&order=sideways&page=0&pageSize=-1",
        ),
      ),
    ).toMatchObject({ order: "desc", page: 1, pageSize: 25, sort: "lastActivity" });
  });

  it("serializes current filters and removes stale comparison ids", () => {
    const search = updateTurnSearch(new URLSearchParams("ids=one,two&stale=kept"), {
      from: "2026-07-01",
      models: ["gpt-a", "gpt-b"],
      order: "asc",
      page: 3,
      pageSize: 50,
      pressure: "70-84",
      query: "turn",
      sort: "duration",
      status: "completed",
      to: "2026-07-12",
    });

    expect(search.get("ids")).toBeNull();
    expect(search.get("stale")).toBe("kept");
    expect(search.toString()).toContain("models=gpt-a%2Cgpt-b");
    expect(Object.fromEntries(search)).toMatchObject({
      from: "2026-07-01",
      order: "asc",
      page: "3",
      pageSize: "50",
      pressure: "70-84",
      q: "turn",
      sort: "duration",
      status: "completed",
      to: "2026-07-12",
    });
  });
});
