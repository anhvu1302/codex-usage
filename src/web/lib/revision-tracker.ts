export type RevisionSnapshotAction = "initialize" | "invalidate" | "scoped" | "unchanged";

export function reconcileRevisionSnapshot(
  lastRevision: number | null,
  nextRevision: number,
): RevisionSnapshotAction {
  if (lastRevision === null) return "initialize";
  if (lastRevision === nextRevision) return "unchanged";
  return nextRevision === lastRevision + 1 ? "scoped" : "invalidate";
}
