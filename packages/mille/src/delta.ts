// Per-session delta computation — Phase 7 commit 7.5.
//
// The host drains the global fx_core::ChangeSet once per coalescer tick
// (via `FileExplorer.takePendingChanges()`), then intersects it with each
// attached session's view (expanded folders + knownIds) to produce a
// minimal per-session delta. SPEC §4.9.9: "Delta diff is indexed, not
// quadratic" — cost is O(|changed|) per session rather than
// O(|sessions| × |expanded|).
//
// Wave 4 layers viewport-aware added/removed-ids on top of this; for now
// the function is pure and deterministic so it can be unit-tested without
// a native explorer.

/**
 * Shape produced by `FileExplorer.takePendingChanges()`. Mirrors
 * `ChangeSetJs` in crates/fx-binding/src/types.rs; napi-rs rewrites
 * snake_case to camelCase so these are the JS-visible field names.
 */
export interface ChangeSet {
  changedIds: number[];
  subtreeRootsChanged: number[];
  childSetChanged: number[];
  reparentedIds: ReparentEntry[];
  fromVersion: number;
  toVersion: number;
}

export interface ReparentEntry {
  id: number;
  oldParentId: number | null;
  newParentId: number | null;
}

/**
 * The slice of session state the delta diff needs. Kept narrow so tests
 * can construct a SessionView without pulling in the full Session type
 * from host.ts, and the host can pass either the mutable Session sets
 * directly or a read-only projection.
 */
export interface SessionView {
  /** Folders this session has expanded. */
  expanded: Set<number>;
  /** Ids this session has already been told about. */
  knownIds: Set<number>;
}

/**
 * Per-session delta frame body (matches `DeltaMsg.body` in protocol.ts
 * for the fields we fill today). Wave 4 wires the remaining viewport
 * fields (addedRows / viewportPatch / directChildCounts).
 */
export interface SessionDelta {
  version: number;
  /** Entries whose record changed AND are in this session's known set. */
  changedIds: number[];
  /** Expanded folders whose child list mutated — triggers a re-query. */
  childSetChanged: number[];
  /** Ids the session should drop (not visible anymore or deleted). */
  removedIds: number[];
  /** Fresh ids the session should pick up rows for. */
  addedIds: number[];
  /** Reparenting restricted to ids this session already knows about. */
  reparentedIds: ReparentEntry[];
}

/**
 * Compute a per-session delta by intersecting a global ChangeSet with
 * the session's view.
 *
 * Algorithm (SPEC §4.9.9):
 *  1. changedIds    = changeSet.changedIds    ∩ session.knownIds
 *  2. childSetChanged = changeSet.childSetChanged ∩ (expanded ∪ knownIds)
 *                      (a child-set mutation is interesting if the parent
 *                      is expanded — the child list renders live — or if
 *                      we've already told the session about the parent)
 *  3. reparentedIds = changeSet.reparentedIds  ∩ session.knownIds
 *  4. addedIds / removedIds: Wave 4 derives these from viewport +
 *     visibility-transition tracking. For now both stay empty; mutations
 *     dispatched through the session explicitly manage knownIds.
 */
export function computeSessionDelta(
  changeSet: ChangeSet,
  session: SessionView,
): SessionDelta {
  const changedIds: number[] = [];
  for (const id of changeSet.changedIds) {
    if (session.knownIds.has(id)) changedIds.push(id);
  }

  const childSetChanged: number[] = [];
  for (const parentId of changeSet.childSetChanged) {
    if (session.expanded.has(parentId) || session.knownIds.has(parentId)) {
      childSetChanged.push(parentId);
    }
  }

  const reparentedIds: ReparentEntry[] = [];
  for (const r of changeSet.reparentedIds) {
    if (session.knownIds.has(r.id)) reparentedIds.push(r);
  }

  return {
    version: changeSet.toVersion,
    changedIds,
    childSetChanged,
    removedIds: [],
    addedIds: [],
    reparentedIds,
  };
}

/**
 * Fold a delta back into the session's knownIds set. Called after the
 * delta frame has been posted so the next tick's diff reflects what the
 * session has now seen.
 */
export function applyDeltaToSession(delta: SessionDelta, session: SessionView): void {
  for (const id of delta.addedIds) session.knownIds.add(id);
  for (const id of delta.removedIds) session.knownIds.delete(id);
}
