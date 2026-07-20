import { describe, expect, it } from "vitest";

import { canonicalSavedSearch, parseSavedViews } from "@/web/lib/saved-views";

describe("Saved Views storage", () => {
  it("allowlists and canonicalizes route-owned filters", () => {
    expect(
      canonicalSavedSearch(
        "/turns",
        "?page=5&ids=one,two&project=p1&model=gpt-a&q=slow&sort=cost&agentPage=8&tags=t2,t1",
      ),
    ).toBe("models=gpt-a&project=p1&q=slow&sort=cost&tags=t1%2Ct2");
    expect(
      canonicalSavedSearch(
        "/activity",
        "tab=health&kinds=shell,patch&session=s1&projectPage=4&from=2026-07-01&to=2026-07-20",
      ),
    ).toBe("from=2026-07-01&kinds=shell%2Cpatch&session=s1&tab=health&to=2026-07-20");
  });

  it("rejects malformed documents and unknown versions", () => {
    expect(parseSavedViews("not-json")).toEqual([]);
    expect(parseSavedViews(JSON.stringify({ version: 2, views: [] }))).toEqual([]);
    expect(parseSavedViews(JSON.stringify({ version: 1, views: "invalid" }))).toEqual([]);
  });

  it("sanitizes records, removes duplicate names and caps the list", () => {
    const timestamp = "2026-07-20T00:00:00.000Z";
    const views = Array.from({ length: 22 }, (_, index) => ({
      createdAt: timestamp,
      id: `view-${index}`,
      name: index === 1 ? "  VIEW 0  " : `View ${index}`,
      pathname: index === 2 ? "/turns/not-a-view" : "/turns",
      search: "page=4&q=cost&unknown=secret",
      updatedAt: new Date(Date.parse(timestamp) + index * 1_000).toISOString(),
      version: 1,
    }));
    const parsed = parseSavedViews(JSON.stringify({ version: 1, views }));
    expect(parsed).toHaveLength(20);
    expect(parsed.some((view) => view.id === "view-1")).toBe(false);
    expect(parsed.some((view) => view.id === "view-2")).toBe(false);
    expect(parsed.every((view) => view.search === "q=cost")).toBe(true);
    expect(parsed[0]!.updatedAt >= parsed.at(-1)!.updatedAt).toBe(true);
  });
});
