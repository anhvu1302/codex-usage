import { describe, expect, it } from "vitest";

import { reconcileRevisionSnapshot } from "@/web/lib/revision-tracker";

describe("reconcileRevisionSnapshot", () => {
  it("initializes without refetching and ignores an unchanged reconnect snapshot", () => {
    expect(reconcileRevisionSnapshot(null, 7)).toBe("initialize");
    expect(reconcileRevisionSnapshot(7, 7)).toBe("unchanged");
  });

  it("invalidates after missed revisions or a server restart", () => {
    expect(reconcileRevisionSnapshot(7, 9)).toBe("invalidate");
    expect(reconcileRevisionSnapshot(7, 1)).toBe("invalidate");
  });

  it("preserves the change-set when reconnect missed exactly one revision", () => {
    expect(reconcileRevisionSnapshot(7, 8)).toBe("scoped");
  });
});
