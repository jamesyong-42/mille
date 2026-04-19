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

  /** Flat-slice algorithm arrives in Phase 8.4. */
  visibleRows(_options: VisibleRowsOptions): readonly VisibleRow[] {
    throw new Error('ClientMirrorSnapshot.visibleRows: implemented in Phase 8.4');
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
