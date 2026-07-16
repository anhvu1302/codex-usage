import type { AppRevisionEvent, AppRevisionReason, AppRevisionScope } from "@/shared/types";

type RevisionListener = (event: AppRevisionEvent) => void;
const PROCESS_REVISION_BASE = Date.now() * 1_000 + (process.pid % 1_000);

export class AppEventBus {
  private latest: AppRevisionEvent;
  private readonly listeners = new Set<RevisionListener>();

  constructor(initialRevision = PROCESS_REVISION_BASE) {
    if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) {
      throw new RangeError("initialRevision must be a non-negative safe integer");
    }
    this.latest = { reason: "import", revision: initialRevision, scopes: [] };
  }

  getRevision(): AppRevisionEvent {
    return {
      ...this.latest,
      ...(this.latest.scopes ? { scopes: [...this.latest.scopes] } : {}),
    };
  }

  publish(
    reason: AppRevisionReason,
    scopes: readonly AppRevisionScope[] = defaultScopes(reason),
  ): AppRevisionEvent {
    this.latest = {
      reason,
      revision: this.latest.revision + 1,
      scopes: [...new Set(scopes)].sort(),
    };
    for (const listener of this.listeners) listener(this.getRevision());
    return this.getRevision();
  }

  subscribe(listener: RevisionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function defaultScopes(reason: AppRevisionReason): readonly AppRevisionScope[] {
  switch (reason) {
    case "budget":
      return ["budgets"];
    case "project":
      return ["activity", "agents", "catalog", "projects", "sessions", "turns"];
    case "rate":
      return [
        "agents",
        "catalog",
        "dashboard",
        "data-health",
        "projects",
        "rates",
        "sessions",
        "turns",
      ];
    case "retention":
      return [
        "activity",
        "agents",
        "dashboard",
        "data-health",
        "projects",
        "sessions",
        "storage",
        "turns",
      ];
    case "import":
      return [
        "activity",
        "agents",
        "catalog",
        "dashboard",
        "data-health",
        "projects",
        "sessions",
        "storage",
        "turns",
      ];
  }
}
