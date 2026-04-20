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

import {
  cloneMirror,
  type ClientEntry,
  type DecorationOnWireLocal,
  type MirrorWorking,
} from './mirror.js';

/**
 * Default ceiling for the client mirror (SPEC §4.9.7). Keeps idle
 * session memory bounded on long-running renderers that scroll
 * through large monorepos — the first 4096 entries are plenty for
 * the common case (viewport + overscan + the surrounding expansion
 * tree), and eviction beyond that pulls cold folders' entries back
 * across the wire on demand.
 */
export const DEFAULT_MIRROR_CAP = 4096;

/**
 * Trim `state.byId` (and the aliased child/count maps) back to
 * `cap` entries by evicting the oldest lruTouch timestamps first.
 * Entries pinned by activeIds (current expansion set + roots)
 * always survive — the viewport would otherwise thrash on every
 * tick. Phase 9 layers in viewport-scoped pinning on top.
 */
export function evictToCap(
  state: MirrorWorking,
  cap: number,
  activeIds: ReadonlySet<number>,
): void {
  if (state.byId.size <= cap) return;
  // Candidate pool: everything in byId that isn't active.
  const candidates: Array<{ id: number; touch: number }> = [];
  for (const id of state.byId.keys()) {
    if (activeIds.has(id)) continue;
    const touch = state.lruTouch.get(id) ?? 0;
    candidates.push({ id, touch });
  }
  // Oldest first. Ties break by id to keep eviction deterministic.
  candidates.sort((a, b) => a.touch - b.touch || a.id - b.id);

  let toEvict = state.byId.size - cap;
  for (const c of candidates) {
    if (toEvict <= 0) break;
    state.byId.delete(c.id);
    state.children.delete(c.id);
    state.directChildCounts.delete(c.id);
    state.pendingExpansions.delete(c.id);
    state.volatileSubtrees.delete(c.id);
    state.lruTouch.delete(c.id);
    toEvict--;
  }
  // If we couldn't evict enough (everything is active), just stop —
  // better to overrun the cap than evict the viewport out from under
  // the renderer. Phase 9's viewport-scoped pinning tightens this.
}

/** Compute the "active" set — entries that must never be evicted. */
function activeSet(state: MirrorWorking): Set<number> {
  const active = new Set<number>();
  for (const id of state.roots) active.add(id);
  for (const id of state.pendingExpansions) active.add(id);
  return active;
}

/** Bump an id's LRU touch. Called on every insert/update. */
function touch(state: MirrorWorking, id: number): void {
  state.lruCounter++;
  // Guard against overflow on very-long-running sessions. Extremely
  // unlikely (would need ~9e15 updates) but cheap to handle.
  if (state.lruCounter >= Number.MAX_SAFE_INTEGER) {
    state.lruCounter = state.byId.size;
    // Rebuild a compressed timeline so cap eviction still works.
    let i = 0;
    for (const k of state.lruTouch.keys()) state.lruTouch.set(k, ++i);
  }
  state.lruTouch.set(id, state.lruCounter);
}

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
  /**
   * Phase A1 — entry ids whose merged decoration set changed since the
   * previous delta. The reducer replaces `decorations[id]` for each
   * listed id from `decorationsJson`, deleting the key when the list
   * is empty.
   */
  decorationChangedIds?: number[];
  /**
   * JSON-encoded `Record<string, DecorationOnWire[]>` keyed by
   * stringified entry id. Must contain an entry for every id in
   * `decorationChangedIds`; the reducer treats absence as the empty
   * array (i.e. clear the slot).
   */
  decorationsJson?: string;
  /**
   * Phase B1 — the full current root-id list on the host. Shipped only
   * when the set changed since the previous delta (by content). When
   * present, the reducer replaces `next.roots` with this list; absent
   * means the root set is unchanged (common case). No dedicated
   * version bump — root churn rides the delta's `version` field.
   */
  roots?: number[];
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
 *
 * `mirrorCap` bounds the post-apply byId size (SPEC §4.9.7). Exceeds
 * the cap evict oldest-touch entries first until we're back under.
 */
export function applySnapshot(
  _prev: MirrorWorking,
  msg: InboundSnapshot,
  mirrorCap: number = DEFAULT_MIRROR_CAP,
): MirrorWorking {
  const next: MirrorWorking = {
    byId: new Map(),
    children: new Map(),
    directChildCounts: new Map(),
    pendingExpansions: new Set(),
    roots: [...msg.roots],
    treeVersion: msg.version,
    decorationVersion: 0,
    decorations: new Map(),
    volatileSubtrees: new Set(),
    lruTouch: new Map(),
    lruCounter: 0,
  };

  if (msg.entriesJson !== undefined && msg.entriesJson.length > 0) {
    const entries = JSON.parse(msg.entriesJson) as ClientEntry[];
    for (const e of entries) {
      next.byId.set(e.id, e);
      touch(next, e.id);
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

  evictToCap(next, mirrorCap, activeSet(next));
  return next;
}

/**
 * Incremental merge. Produces a fresh MirrorWorking (via
 * cloneMirror) so the previous snapshot's view of the data stays
 * stable for its lifetime. `mirrorCap` bounds the post-merge byId
 * size — entries in folders not currently expanded are evicted
 * oldest-touch-first when we overflow (SPEC §4.9.7).
 */
export function applyDelta(
  state: MirrorWorking,
  msg: InboundDelta,
  mirrorCap: number = DEFAULT_MIRROR_CAP,
): MirrorWorking {
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
      touch(next, e.id);
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

  // Drop removed ids from lruTouch so they don't skew eviction
  // ordering on the next tick.
  for (const id of msg.removedIds) next.lruTouch.delete(id);

  // Phase A1 — apply decoration deltas. Separate channel from the
  // tree bump: a decoration-only delta still carries a (possibly
  // unchanged) `version` field, so the reducer doesn't differentiate
  // here. The host advances `decorationVersion` on every decoration
  // change so consumers gating on it see a fresh snapshot.
  const decChangedIds = msg.decorationChangedIds ?? [];
  if (decChangedIds.length > 0) {
    let parsed: Record<string, readonly DecorationOnWireLocal[]> = {};
    if (msg.decorationsJson !== undefined && msg.decorationsJson.length > 0) {
      try {
        parsed = JSON.parse(msg.decorationsJson) as Record<
          string,
          readonly DecorationOnWireLocal[]
        >;
      } catch {
        // Malformed decoration payload — skip applying rather than
        // corrupt the store. The next tick will overwrite anyway.
        parsed = {};
      }
    }
    for (const id of decChangedIds) {
      const key = String(id);
      const decs = parsed[key];
      if (decs === undefined || decs.length === 0) {
        next.decorations.delete(id);
      } else {
        next.decorations.set(id, decs);
      }
    }
    next.decorationVersion += 1;
  }

  // Removed ids should also drop their decoration slot — a stale
  // entry has no merged decorations.
  for (const id of msg.removedIds) next.decorations.delete(id);

  // Phase B1 — roots delta. Replace wholesale with the host-supplied
  // list when present. Identity-stable where possible: we reuse the
  // prior `next.roots` array if every id is the same in the same
  // order, so consumers doing shallow `===` comparisons (e.g. React
  // memoised over `snap.roots()` identity) don't re-render
  // unnecessarily. When an id in the delta isn't yet in `byId`
  // (edge case: roots arrive before the entry record), the id is kept
  // in the roots list; downstream code (`snap.roots()` and
  // `visibleRows`) already tolerates missing entries — roots() skips
  // them, visibleRows emits a pending placeholder. The real Entry
  // lands on the same or a subsequent tick.
  if (msg.roots !== undefined) {
    const incoming = msg.roots;
    const prev = next.roots;
    let same = prev.length === incoming.length;
    if (same) {
      for (let i = 0; i < incoming.length; i++) {
        if (prev[i] !== incoming[i]) {
          same = false;
          break;
        }
      }
    }
    next.roots = same ? prev : [...incoming];
  }

  evictToCap(next, mirrorCap, activeSet(next));
  return next;
}
