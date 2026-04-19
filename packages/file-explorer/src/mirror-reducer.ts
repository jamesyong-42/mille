// ViewportMirror delta reducer — Phase 8 commit 8.3.
//
// Pure reducer over MirrorWorking. applySnapshot() is the full
// replacement path used at handshake time (and whenever the host
// forces a resync). applyDelta() is the incremental merge the wire
// calls on every tick.
//
// Payload encoding: Phase 8 ships JSON inside a string field for
// entry records (see SPEC §4.9.1 note on encoding). Bincode for the
// client mirror arrives in Phase 12 with benchmarks; current loads
// are small enough that JSON's overhead is invisible.
//
// Invariants this module preserves (SPEC §4.9.5 invalidation rules):
//   - A delta's `version` becomes the new `treeVersion` regardless of
//     whether anything else in the body is non-empty. Monotonic
//     per-session (enforced upstream in client-port.ts).
//   - `coarseSubtrees` and `subtreeDirty` are orthogonal flags. A
//     coarse subtree drops its known child list + joins
//     pendingExpansions (the client must re-query). A dirty subtree
//     joins volatileSubtrees but retains its cached child list until
//     the resync marker arrives.
//   - `subtreeResynced` clears the volatile flag on the subtree root.
//     The host guarantees these flags are mutually-exclusive per
//     tick (see SPEC §4.9.10) so same-tick-dirty+resynced is not a
//     case we have to arbitrate.

import { cloneMirror, type ClientEntry, type MirrorWorking } from './mirror.js';

/**
 * Inbound snapshot frame body. The host serializes ClientEntry
 * records as JSON inside `entriesJson` so the wire doesn't need a
 * schema negotiation for Phase 8.
 */
export interface InboundSnapshot {
  version: number;
  roots: number[];
  /** JSON-encoded ClientEntry[]. Absent when the snapshot is empty. */
  entriesJson?: string;
  /** parentId → direct child count. JSON-object, string keys. */
  directChildCounts: Record<string, number>;
  /** Total rows currently visible on the host side. Informational. */
  visibleCount: number;
}

/** Inbound delta frame body — incremental merge payload. */
export interface InboundDelta {
  version: number;
  /** Ids whose ClientEntry shape changed — values in `entriesJson`. */
  changedIds: number[];
  /** JSON-encoded ClientEntry[] for added + changed ids. */
  entriesJson?: string;
  /**
   * Parents whose child list mutated (add/remove/reparent). The reducer
   * rebuilds `children[parent]` from byId+parentId after merging
   * entries, and clears `pendingExpansions[parent]` so the visible-
   * row count stops reporting a stale spinner.
   */
  childSetChanged?: number[];
  /** Ids removed from the mirror entirely. */
  removedIds: number[];
  /** Fresh direct-child-count values to merge in. */
  directChildCounts: Record<string, number>;
  /** Subtrees flagged coarse (SPEC §4.9.9 / wave 2 7.7). */
  coarseSubtrees: number[];
  /** Subtrees flipped volatile / resynced (7.9, SPEC §4.9.10). */
  subtreeDirty: number[];
  subtreeResynced: number[];
}

/**
 * Wholesale replacement. Used at handshake time and whenever the
 * host forces a resync. Returns a brand-new MirrorWorking; callers
 * should treat the previous one as discarded.
 *
 * Children lists are derived from the entries' `parentId`. The wire
 * doesn't ship a separate children map — every (entry, parent) pair
 * reaches us as the entry's own parentId, and snapshots are total so
 * grouping byId is sufficient to recover the full child set.
 */
export function applySnapshot(_prev: MirrorWorking, msg: InboundSnapshot): MirrorWorking {
  const next: MirrorWorking = {
    byId: new Map(),
    children: new Map(),
    directChildCounts: new Map(),
    pendingExpansions: new Set(),
    roots: [...msg.roots],
    treeVersion: msg.version,
    decorationVersion: 0,
    volatileSubtrees: new Set(),
  };

  if (msg.entriesJson !== undefined && msg.entriesJson.length > 0) {
    const entries = JSON.parse(msg.entriesJson) as ClientEntry[];
    for (const e of entries) {
      next.byId.set(e.id, e);
    }
    // Rebuild children from parentId. A fresh map guarantees no stale
    // child lists leak through — snapshot is authoritative.
    for (const e of entries) {
      if (e.parentId === null) continue;
      const list = next.children.get(e.parentId);
      if (list === undefined) {
        next.children.set(e.parentId, [e.id]);
      } else {
        list.push(e.id);
      }
    }
  }

  for (const [k, v] of Object.entries(msg.directChildCounts)) {
    next.directChildCounts.set(Number(k), v);
  }

  return next;
}

/**
 * Incremental merge. Produces a fresh MirrorWorking (via
 * cloneMirror) so the previous snapshot's view of the data stays
 * stable for its lifetime.
 */
export function applyDelta(state: MirrorWorking, msg: InboundDelta): MirrorWorking {
  const next = cloneMirror(state);
  next.treeVersion = msg.version;

  // Track parents whose child list needs rebuilding. Starts with
  // whatever the host told us mutated (`childSetChanged`) plus any
  // parent we discover as we merge entries — an entry whose parentId
  // doesn't already have that id in `children[parent]` is a new child.
  const parentsToRebuild = new Set<number>(msg.childSetChanged ?? []);

  // Add / update entries.
  if (msg.entriesJson !== undefined && msg.entriesJson.length > 0) {
    const entries = JSON.parse(msg.entriesJson) as ClientEntry[];
    for (const e of entries) {
      const prev = next.byId.get(e.id);
      next.byId.set(e.id, e);
      // Reparented? mark both old + new parent for rebuild.
      if (prev !== undefined && prev.parentId !== e.parentId) {
        if (prev.parentId !== null) parentsToRebuild.add(prev.parentId);
        if (e.parentId !== null) parentsToRebuild.add(e.parentId);
      } else if (prev === undefined && e.parentId !== null) {
        // New entry — parent's child list grew.
        parentsToRebuild.add(e.parentId);
      }
    }
  }

  // Remove entries — drop any aliased cache entries alongside and
  // flag the parent for rebuild so the residual child list refreshes.
  for (const id of msg.removedIds) {
    const prev = next.byId.get(id);
    if (prev !== undefined && prev.parentId !== null) {
      parentsToRebuild.add(prev.parentId);
    }
    next.byId.delete(id);
    next.children.delete(id);
    next.directChildCounts.delete(id);
    next.pendingExpansions.delete(id);
    next.volatileSubtrees.delete(id);
  }

  // Rebuild child lists for dirty parents. O(|byId|) per delta but
  // the delta only rebuilds when something actually moved, so amortized
  // cost stays low. Phase 12 adds an explicit children-diff section if
  // this shows up on the flame graph.
  if (parentsToRebuild.size > 0) {
    // Group every entry by its parentId so we can slice out the new
    // child list in one pass. Subsetting to just the dirty parents
    // keeps the map small on most ticks.
    const byParent = new Map<number, number[]>();
    for (const [id, e] of next.byId) {
      if (e.parentId === null) continue;
      if (!parentsToRebuild.has(e.parentId)) continue;
      const list = byParent.get(e.parentId);
      if (list === undefined) byParent.set(e.parentId, [id]);
      else list.push(id);
    }
    for (const parentId of parentsToRebuild) {
      const fresh = byParent.get(parentId) ?? [];
      next.children.set(parentId, fresh);
      // Arrival of a parent's children clears its pendingExpansions
      // flag — consumers stop rendering a spinner for it.
      next.pendingExpansions.delete(parentId);
    }
  }

  // Merge direct-child-counts (fresh values win).
  for (const [k, v] of Object.entries(msg.directChildCounts)) {
    next.directChildCounts.set(Number(k), v);
  }

  // Coarse subtrees: drop the known child list + mark pending so
  // the client will re-query this subtree on its next viewport pass.
  for (const rootId of msg.coarseSubtrees) {
    next.children.delete(rootId);
    next.pendingExpansions.add(rootId);
  }

  // Volatile flags.
  for (const id of msg.subtreeDirty) next.volatileSubtrees.add(id);
  for (const id of msg.subtreeResynced) next.volatileSubtrees.delete(id);

  return next;
}
