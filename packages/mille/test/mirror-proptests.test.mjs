// Property-based tests for the ViewportMirror — Phase 8 commit 8.11.
//
// Mirrors the shape of crates/fx-core/tests/resume_proptests.rs and
// the `prop_visible_row_count_matches_naive` proptest in
// crates/fx-core/src/snapshot.rs. Covers:
//
//   1. applySnapshot drives treeVersion to msg.version (handshake-style
//      replacement — the reducer accepts any version, monotonicity is
//      enforced upstream in client-port.ts).
//   2. applyDelta propagates the delta's version. Over a monotonically
//      increasing delta sequence the working treeVersion stays monotonic.
//   3. visibleRows(limit=∞).length === visibleRowCount(expanded).known
//      whenever roots are a subset of entries (i.e. no cache-miss
//      placeholders — those are emitted by visibleRows but DFS'd past
//      by visibleRowCount). This is the TS mirror of fx-core's
//      snapshot.rs proptest.
//   4. mirrorCap bound — after arbitrary apply sequences, byId.size
//      stays at or under `cap + |active ∩ byId|`, matching the
//      evictToCap "active ids are pinned above the cap" contract.
//   5. ClientMirrorSnapshot is frozen: assigning to an own property
//      throws in strict mode (ES modules are strict by default).
//
// 50 runs per invariant — tight enough to keep the whole file under
// ~1s, wide enough to exercise the edge cases unit tests don't.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fc from 'fast-check';
import { createMirror } from '../dist/mirror.js';
import { applySnapshot, applyDelta, DEFAULT_MIRROR_CAP } from '../dist/mirror-reducer.js';
import { ClientMirrorSnapshot } from '../dist/mirror-snapshot.js';

// ─── Arbitraries ────────────────────────────────────────────────────

// Bounded id pool — keeps collisions frequent enough that deltas
// actually update + reparent existing entries instead of always
// accreting new ones. Large enough to exercise non-trivial trees.
const ID_POOL = 64;

const idArb = fc.integer({ min: 1, max: ID_POOL });

// ClientEntry shape — null-for-undefined holes, matching both wire codecs.
const entryArb = fc.record({
  id: idArb,
  parentId: fc.option(idArb, { nil: null }),
  name: fc.string({ minLength: 1, maxLength: 6 }),
  kind: fc.integer({ min: 0, max: 3 }),
  size: fc.nat(10_000),
  mtimeMs: fc.nat(),
  ctimeMs: fc.nat(),
  symlinkTargetIsDir: fc.option(fc.boolean(), { nil: null }),
  pathSegments: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 4 }), {
    nil: null,
  }),
  isIgnored: fc.boolean(),
  isReadonly: fc.boolean(),
  isHidden: fc.boolean(),
});

// De-dupe entries by id — entry payloads decode to arrays but the reducer
// treats later occurrences as overwrites, which weakens "apply a
// snapshot means exactly these ids live in byId" guarantees.
function dedupeById(entries) {
  const seen = new Map();
  for (const e of entries) seen.set(e.id, e);
  return [...seen.values()];
}

// Snapshot-frame arbitrary. `roots` is drawn from the generated
// entries so visibleRows won't emit placeholder rows (which break
// invariant 3).
const snapshotArb = fc
  .record({
    version: fc.nat(1_000_000),
    entries: fc.array(entryArb, { maxLength: 24 }).map(dedupeById),
    countsExtra: fc.dictionary(fc.integer({ min: 1, max: ID_POOL }).map(String), fc.nat(20), {
      maxKeys: 8,
    }),
    visibleCount: fc.nat(50),
    rootsPickMask: fc.integer({ min: 0, max: 0xffff_ffff }),
  })
  .map(({ version, entries, countsExtra, visibleCount, rootsPickMask }) => {
    // Pick up to 4 roots from the entries themselves. If there are no
    // entries, roots is empty — valid.
    const roots = [];
    if (entries.length > 0) {
      const rootCount = Math.min(entries.length, (rootsPickMask & 0x3) + 1);
      const seen = new Set();
      for (let i = 0; i < rootCount; i++) {
        const pickIdx =
          (((rootsPickMask >>> (2 + i * 6)) % entries.length) + entries.length) % entries.length;
        const pickId = entries[pickIdx].id;
        if (!seen.has(pickId)) {
          seen.add(pickId);
          roots.push(pickId);
        }
      }
    }
    // directChildCounts seeded from the actual parent structure so the
    // counts aren't pure noise. Extra arbitrary keys are merged on top.
    const directChildCounts = { ...countsExtra };
    const childTally = new Map();
    for (const e of entries) {
      if (e.parentId !== null) {
        childTally.set(e.parentId, (childTally.get(e.parentId) ?? 0) + 1);
      }
    }
    for (const [pid, n] of childTally) directChildCounts[String(pid)] = n;
    return {
      version,
      roots,
      entriesJson: entries.length > 0 ? JSON.stringify(entries) : undefined,
      directChildCounts,
      visibleCount,
    };
  });

// Delta-frame arbitrary. All id fields drawn from the same pool as
// snapshotArb so a delta can plausibly reference entries the snapshot
// installed.
const deltaArb = fc
  .record({
    version: fc.nat(1_000_000),
    entries: fc.array(entryArb, { maxLength: 12 }).map(dedupeById),
    removedIds: fc.array(idArb, { maxLength: 6 }),
    childSetChanged: fc.array(idArb, { maxLength: 4 }),
    coarseSubtrees: fc.array(idArb, { maxLength: 3 }),
    subtreeDirty: fc.array(idArb, { maxLength: 3 }),
    subtreeResynced: fc.array(idArb, { maxLength: 3 }),
    countsExtra: fc.dictionary(fc.integer({ min: 1, max: ID_POOL }).map(String), fc.nat(20), {
      maxKeys: 6,
    }),
  })
  .map((r) => ({
    version: r.version,
    changedIds: r.entries.map((e) => e.id),
    entriesJson: r.entries.length > 0 ? JSON.stringify(r.entries) : undefined,
    removedIds: r.removedIds,
    childSetChanged: r.childSetChanged,
    coarseSubtrees: r.coarseSubtrees,
    subtreeDirty: r.subtreeDirty,
    subtreeResynced: r.subtreeResynced,
    directChildCounts: r.countsExtra,
  }));

// ─── Invariant 1: applySnapshot sets treeVersion ───────────────────

test('prop: applySnapshot drives treeVersion to msg.version', () => {
  fc.assert(
    fc.property(snapshotArb, (msg) => {
      const state = applySnapshot(createMirror(), msg);
      return state.treeVersion === msg.version;
    }),
    { numRuns: 50 },
  );
});

// ─── Invariant 2: treeVersion monotonic across ascending deltas ────

test('prop: treeVersion monotonic across a delta sequence with ascending versions', () => {
  fc.assert(
    fc.property(snapshotArb, fc.array(deltaArb, { minLength: 1, maxLength: 8 }), (snap, deltas) => {
      // Normalize versions to be strictly ascending starting from
      // snap.version + 1. The reducer itself accepts arbitrary
      // versions (monotonicity is a client-port.ts concern); here we
      // verify that when the wire DOES feed it a monotonic stream,
      // the working treeVersion tracks monotonically too.
      let v = snap.version;
      let state = applySnapshot(createMirror(), snap);
      let prev = state.treeVersion;
      for (const d of deltas) {
        v += 1 + (d.version % 5); // strictly increasing, bounded step
        const dd = { ...d, version: v };
        state = applyDelta(state, dd);
        if (state.treeVersion < prev) return false;
        if (state.treeVersion !== v) return false;
        prev = state.treeVersion;
      }
      return true;
    }),
    { numRuns: 50 },
  );
});

// ─── Invariant 3: visibleRows.length === visibleRowCount.known ─────

test('prop: visibleRows.length agrees with visibleRowCount.known', () => {
  fc.assert(
    fc.property(
      snapshotArb,
      fc.array(idArb, { maxLength: 12 }),
      fc.boolean(),
      (snap, expandedIds, includeIgnored) => {
        const state = applySnapshot(createMirror(), snap);
        const sn = new ClientMirrorSnapshot(state);
        const expanded = new Set(expandedIds);
        // With the snapshot arb's `roots ⊆ entries.id` guarantee the
        // DFS never hits a cache-miss placeholder, so visibleRows and
        // visibleRowCount agree exactly. (Placeholder handling is
        // covered by visible-rows.test.mjs.)
        const rows = sn.visibleRows({
          expanded,
          offset: 0,
          limit: Number.MAX_SAFE_INTEGER,
          includeIgnored,
        });
        const count = sn.visibleRowCount(expanded, includeIgnored);
        return rows.length === count.known;
      },
    ),
    { numRuns: 50 },
  );
});

// ─── Invariant 4: mirrorCap bound holds ────────────────────────────

test('prop: byId.size stays bounded by cap + pinned-active after arbitrary apply sequences', () => {
  fc.assert(
    fc.property(
      snapshotArb,
      fc.array(deltaArb, { maxLength: 6 }),
      fc.integer({ min: 1, max: 16 }),
      (snap, deltas, cap) => {
        let state = applySnapshot(createMirror(), snap, cap);
        // Active set is roots + expansion state + viewport — the evictor pins
        // these above the cap (see mirror-reducer.ts evictToCap). The
        // bound we prove here is byId.size <= cap + |active ∩ byId|.
        const activeCount = (s) => {
          const active = new Set();
          for (const id of s.roots) active.add(id);
          for (const id of s.expanded) active.add(id);
          for (const id of s.pendingExpansions) active.add(id);
          for (const id of s.viewportIds) active.add(id);
          let n = 0;
          for (const id of active) if (s.byId.has(id)) n++;
          return n;
        };
        if (state.byId.size > cap + activeCount(state)) return false;
        let v = snap.version;
        for (const d of deltas) {
          v += 1;
          state = applyDelta(state, { ...d, version: v }, cap);
          if (state.byId.size > cap + activeCount(state)) return false;
        }
        return true;
      },
    ),
    { numRuns: 50 },
  );
});

// ─── Invariant 5: ClientMirrorSnapshot is frozen ───────────────────

test('prop: ClientMirrorSnapshot instances are frozen (strict-mode TypeError on mutation)', () => {
  fc.assert(
    fc.property(snapshotArb, (snap) => {
      const state = applySnapshot(createMirror(), snap);
      const sn = new ClientMirrorSnapshot(state);
      // ES module code is strict by default — assignment to a frozen
      // object must throw. Any of these properties would do; try a
      // few to cover both existing and new keys.
      let threwOnExisting = false;
      let threwOnNew = false;
      try {
        sn.treeVersion = 999;
      } catch (e) {
        threwOnExisting = e instanceof TypeError;
      }
      try {
        sn.newField = 'x';
      } catch (e) {
        threwOnNew = e instanceof TypeError;
      }
      return threwOnExisting && threwOnNew && Object.isFrozen(sn);
    }),
    { numRuns: 50 },
  );
});
