// ClientMirrorSnapshot — Phase 8 commit 8.2.
//
// Frozen, consumer-facing wrapper around a MirrorWorking. Identity
// is stable until the next delta: the reducer (8.3) produces a new
// MirrorWorking + wraps it in a new ClientMirrorSnapshot only when
// something actually changed. That lets React's useSyncExternalStore
// gate re-renders on `===` identity per SPEC §4.9.1.
//
// Per api.d.ts MirrorSnapshot — visibleRows + visibleRowCount land
// in Phase 8.4 + 8.5 once the flat-slice algorithm + pendingExpansions
// logic arrive. They throw for now so the method is discoverable
// but accidental calls fail loudly.
//
// Entry / EntryId / VisibleRow / VisibleRowCount / VisibleRowsOptions
// come from client.ts; re-using those mirrors keeps both sides of the
// package on one type surface without coupling to the .d.ts at the
// package root.

import type {
  Decoration,
  Entry,
  EntryId,
  VisibleRow,
  VisibleRowCount,
  VisibleRowsOptions,
} from './client.js';
import type { ClientEntry, MirrorWorking } from './mirror.js';

/**
 * Translate a mirror-local ClientEntry (with `null`-holes) into the
 * public Entry shape (with `undefined`-holes). Spreads only the
 * optional keys that are present, satisfying
 * `exactOptionalPropertyTypes`.
 */
function clientEntryToEntry(c: ClientEntry): Entry {
  const base = {
    id: c.id,
    parentId: c.parentId,
    name: c.name,
    kind: c.kind,
    size: c.size,
    mtimeMs: c.mtimeMs,
    ctimeMs: c.ctimeMs,
    isIgnored: c.isIgnored,
    isReadonly: c.isReadonly,
    isHidden: c.isHidden,
  };
  const out: Entry = {
    ...base,
    ...(c.symlinkTargetIsDir !== null ? { symlinkTargetIsDir: c.symlinkTargetIsDir } : {}),
    ...(c.pathSegments !== null ? { pathSegments: c.pathSegments } : {}),
  };
  return out;
}

/**
 * Sort children by name for deterministic display order. The client
 * may receive child ids out-of-order (the host sends them in
 * id-allocation order, not sorted); sort here using the byId map so
 * wire-order doesn't leak into the rendered tree. Falls back to id
 * comparison when names collide.
 */
function sortChildrenByName(ids: number[], byId: Map<number, ClientEntry>): number[] {
  return [...ids].sort((a, b) => {
    const na = byId.get(a)?.name ?? '';
    const nb = byId.get(b)?.name ?? '';
    if (na === nb) return a - b;
    return na < nb ? -1 : 1;
  });
}

/**
 * Invisibility filter matching fx-core's `entry_counts_visible`.
 * Ignored and hidden entries drop out of the default visible set;
 * `includeIgnored=true` disables both filters (mirroring the Rust
 * side's single boolean).
 */
function isVisibleEntry(e: ClientEntry, includeIgnored: boolean): boolean {
  if (includeIgnored) return true;
  return !e.isIgnored && !e.isHidden;
}

/**
 * Frozen view of a MirrorWorking. Consumers receive this via
 * `PortFileExplorer.getSnapshot()` (wired in Wave 2); identity is
 * stable until the reducer publishes a new one.
 *
 * The snapshot holds a reference to the working state — callers must
 * not retain the MirrorWorking and mutate it behind the snapshot's
 * back. The reducer always produces a fresh MirrorWorking via
 * cloneMirror() before wrapping it here, so the snapshot's view of
 * the data is stable for its lifetime.
 */
export class ClientMirrorSnapshot {
  /** @internal */
  private readonly state: MirrorWorking;

  constructor(state: MirrorWorking) {
    this.state = state;
    // Freeze the wrapper so consumers can't swap the state reference
    // or attach extra properties. The inner maps are not frozen
    // because Map/Set have no Object.freeze-friendly equivalent, but
    // the reducer contract guarantees they won't be mutated after
    // the snapshot is published.
    Object.freeze(this);
  }

  get treeVersion(): number {
    return this.state.treeVersion;
  }

  get decorationVersion(): number {
    return this.state.decorationVersion;
  }

  roots(): readonly Entry[] {
    const out: Entry[] = [];
    for (const id of this.state.roots) {
      const entry = this.state.byId.get(id);
      if (entry !== undefined) out.push(clientEntryToEntry(entry));
    }
    return out;
  }

  getById(id: EntryId): Entry | null {
    const entry = this.state.byId.get(id);
    return entry !== undefined ? clientEntryToEntry(entry) : null;
  }

  directChildCount(id: EntryId): number | null {
    const v = this.state.directChildCounts.get(id);
    return v ?? null;
  }

  hasChildren(id: EntryId): boolean {
    const count = this.state.directChildCounts.get(id) ?? 0;
    return count > 0;
  }

  /**
   * Flat-slice of the visible tree, mirroring fx-core's
   * `snapshot::visible_rows`. Iterative DFS over byId + children:
   *
   *   - Roots are pushed onto the stack in reverse so children pop in
   *     left-to-right order (matches fx-core).
   *   - Ignored / hidden entries are skipped entirely (both themselves
   *     and their descendants), matching `entry_counts_visible`. An
   *     invisible-but-expanded parent MUST NOT emit its children —
   *     otherwise rows would appear at the wrong depth with no parent
   *     above them. SPEC §4.9.2 and the earlier audit both call this out.
   *   - Children are re-sorted by name on read: the wire delivers them
   *     in id-allocation order, not sorted.
   *   - offset/limit slice with early termination: once we've emitted
   *     `limit` rows we return without traversing the rest of the tree.
   *   - Expanded folders whose child list isn't in the mirror are
   *     simply not descended into here — `visibleRowCount` is the
   *     method that surfaces them as pending.
   */
  visibleRows(options: VisibleRowsOptions): readonly VisibleRow[] {
    const includeIgnored = options.includeIgnored ?? false;
    const limit = options.limit;
    if (limit === 0) return [];

    const out: VisibleRow[] = [];
    const expanded = options.expanded;
    let skipped = 0;

    type Frame = { id: number; depth: number };
    const stack: Frame[] = [];

    // Reverse-push so DFS emits roots left-to-right.
    for (let i = this.state.roots.length - 1; i >= 0; i--) {
      stack.push({ id: this.state.roots[i]!, depth: 0 });
    }

    while (stack.length > 0) {
      const frame = stack.pop()!;
      const entry = this.state.byId.get(frame.id);
      if (entry === undefined) continue;
      if (!isVisibleEntry(entry, includeIgnored)) continue; // no emit, no descend

      if (skipped < options.offset) {
        skipped++;
      } else {
        const hasChildren = (this.state.directChildCounts.get(frame.id) ?? 0) > 0;
        const base = clientEntryToEntry(entry);
        const row: VisibleRow = {
          ...base,
          depth: frame.depth,
          hasChildren,
          isExpanded: expanded.has(frame.id),
        };
        out.push(row);
        if (out.length >= limit) return out;
      }

      // Descend only when the expanded parent is itself visible (the
      // invisibility check above already guaranteed that). If the
      // children map doesn't hold this id yet (worker hasn't delivered
      // them), skip descent — visibleRowCount reports it as pending.
      if (expanded.has(frame.id)) {
        const kids = this.state.children.get(frame.id);
        if (kids !== undefined) {
          const sorted = sortChildrenByName(kids, this.state.byId);
          const childDepth = frame.depth + 1;
          for (let i = sorted.length - 1; i >= 0; i--) {
            stack.push({ id: sorted[i]!, depth: childDepth });
          }
        }
      }
    }

    return out;
  }

  /** pendingExpansions-aware counter arrives in Phase 8.5. */
  visibleRowCount(
    _expanded: ReadonlySet<EntryId>,
    _includeIgnored?: boolean,
  ): VisibleRowCount {
    throw new Error('ClientMirrorSnapshot.visibleRowCount: implemented in Phase 8.5');
  }

  /** Decorations land in Phase 9; empty until then. */
  getDecorations(_id: EntryId): readonly Decoration[] {
    return [];
  }
}
