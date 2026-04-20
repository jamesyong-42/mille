// useClipboardState — local cut/copy clipboard state for the tree.
//
// Phase 7 (MILLE_UI_SPEC.md §6.6 / §5.3). In-app semantics only — the
// system clipboard is NOT touched. A single pair of disjoint sets
// (`cutIds` / `copyIds`) represents the current clipboard:
//
//   - `markCut(ids)`  → `cutIds` = Set(ids),   `copyIds` = empty
//   - `markCopy(ids)` → `copyIds` = Set(ids),  `cutIds`  = empty
//   - `clear()`       → both sets empty
//
// `cutIds` drives the row visual state (opacity 0.5 via
// `[data-mille-cut="true"]`); `copyIds` is rendered as plain selection.
// Both sets are frozen-ish from the hook's perspective: callers that
// iterate do NOT need to defensively clone because the hook never
// mutates a returned set — every transition allocates a new Set.

import { useCallback, useMemo, useState } from 'react';
import type { EntryId } from '@vibecook/mille';

/** Stable empty set singleton — avoid per-render allocation on the initial state. */
const EMPTY_SET: ReadonlySet<EntryId> = new Set<EntryId>();

export interface ClipboardStateHandle {
  readonly cutIds: ReadonlySet<EntryId>;
  readonly copyIds: ReadonlySet<EntryId>;
  /**
   * Replace `cutIds` with the given ids; `copyIds` is emptied. Passing
   * an empty iterable is equivalent to `clear()`.
   */
  markCut(ids: Iterable<EntryId>): void;
  /** Symmetric counterpart of `markCut`. */
  markCopy(ids: Iterable<EntryId>): void;
  /** Empty both sets. Idempotent if both are already empty. */
  clear(): void;
}

function materialize(ids: Iterable<EntryId>): ReadonlySet<EntryId> {
  // Fast path: empty input → reuse the singleton.
  // `Iterable` doesn't guarantee a `size` accessor, so we drain into a
  // Set regardless; the singleton fast path below covers the common
  // "clear on empty selection" case without allocation when the caller
  // happens to pass a Set.
  if (ids instanceof Set && ids.size === 0) return EMPTY_SET;
  const next = new Set<EntryId>();
  for (const id of ids) next.add(id);
  if (next.size === 0) return EMPTY_SET;
  return next;
}

/**
 * Hook backing `cutIds` / `copyIds` in `<FileTree>`. Exposes setters
 * that preserve the disjointness invariant — at most one of the two
 * sets is ever non-empty.
 */
export function useClipboardState(): ClipboardStateHandle {
  const [cutIds, setCutIds] = useState<ReadonlySet<EntryId>>(EMPTY_SET);
  const [copyIds, setCopyIds] = useState<ReadonlySet<EntryId>>(EMPTY_SET);

  const markCut = useCallback((ids: Iterable<EntryId>) => {
    const next = materialize(ids);
    setCutIds(next);
    setCopyIds(EMPTY_SET);
  }, []);

  const markCopy = useCallback((ids: Iterable<EntryId>) => {
    const next = materialize(ids);
    setCopyIds(next);
    setCutIds(EMPTY_SET);
  }, []);

  const clear = useCallback(() => {
    // Avoid re-setting the singleton when both are already empty; the
    // identity check prevents a needless render loop.
    setCutIds((prev) => (prev === EMPTY_SET ? prev : EMPTY_SET));
    setCopyIds((prev) => (prev === EMPTY_SET ? prev : EMPTY_SET));
  }, []);

  return useMemo<ClipboardStateHandle>(
    () => ({ cutIds, copyIds, markCut, markCopy, clear }),
    [cutIds, copyIds, markCut, markCopy, clear],
  );
}
