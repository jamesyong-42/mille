// useFileDecorations — merged-decoration reader for a single row.
//
// Phase 10: the row's `decorations` prop is a `MergedDecoration` — a UI
// shape derived from the engine's `readonly Decoration[]` returned by
// `MirrorSnapshot.getDecorations(id)`. The engine already merges
// provider-level decorations (§9.4), but its shape is an array; we
// fold that into the flat UI record once per (snapshot, array-identity)
// pair and cache the result so repeated reads return the same object.
//
// The per-row memo in `FileTreeRow` relies on this identity: if the
// same id's decoration array reference doesn't change across snapshots,
// neither does the merged-decoration output — and the row skips its
// re-render.

import type { Decoration, EntryId } from '@vibecook/mille';
import type { FileTreeSnapshotLike, MergedDecoration } from '../components/types.js';
import { useFileTreeContext } from './useFileTreeContext.js';

/**
 * Shared empty `MergedDecoration` reference. Frozen so consumers can't
 * accidentally mutate it; returned from `useFileDecorations` when the
 * row has no decorations so the row memo treats "no decorations" as
 * identity-stable forever.
 */
export const EMPTY_DECORATION: MergedDecoration = Object.freeze({});

/**
 * Identity-stable cache keyed on the raw `readonly Decoration[]`
 * reference returned by `MirrorSnapshot.getDecorations`. A frozen
 * snapshot keeps returning the same array reference for an unchanged
 * row, so the same merged output is returned — the row memo's identity
 * check passes and the row skips its re-render.
 *
 * Using a module-level `WeakMap` (not a `useMemo`) is intentional: we
 * want the cache to persist across renders without coupling it to a
 * specific tree instance, and the WeakMap releases entries as old
 * snapshots are GC'd.
 */
const MERGE_CACHE = new WeakMap<readonly Decoration[], MergedDecoration>();

/**
 * Fold a provider-merged array into the flat `MergedDecoration` shape
 * the row renders. Later entries override earlier ones on fields —
 * matching SPEC §7.2's "later providers win" rule.
 *
 * Returns the frozen `EMPTY_DECORATION` when the array is empty, so the
 * "no decorations" case is a stable singleton across all rows.
 */
export function mergeDecorations(list: readonly Decoration[]): MergedDecoration {
  if (list.length === 0) return EMPTY_DECORATION;
  const cached = MERGE_CACHE.get(list);
  if (cached !== undefined) return cached;

  let badge: string | undefined;
  let color: string | undefined;
  let tooltip: string | undefined;
  let propagate: boolean | undefined;
  for (const d of list) {
    if (d.badge !== undefined) badge = d.badge;
    if (d.color !== undefined) color = d.color;
    if (d.tooltip !== undefined) {
      tooltip = tooltip === undefined ? d.tooltip : `${tooltip}\n${d.tooltip}`;
    }
    if (d.propagate !== undefined) propagate = d.propagate;
  }

  // Also carry through any UI-only fields a test or companion decoration
  // provider may have stashed on the raw item (letter / fontWeight /
  // strikethrough). Those aren't part of the engine's `Decoration` type
  // today but the UI-side `MergedDecoration` surface supports them.
  let letter: string | undefined;
  let fontWeight: number | undefined;
  let strikethrough: boolean | undefined;
  for (const d of list) {
    const ext = d as unknown as {
      letter?: string;
      fontWeight?: number;
      strikethrough?: boolean;
    };
    if (ext.letter !== undefined) letter = ext.letter;
    if (ext.fontWeight !== undefined) fontWeight = ext.fontWeight;
    if (ext.strikethrough !== undefined) strikethrough = ext.strikethrough;
  }

  const out: MergedDecoration = Object.freeze({
    ...(badge !== undefined ? { badge } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(tooltip !== undefined ? { tooltip } : {}),
    ...(letter !== undefined ? { letter } : {}),
    ...(fontWeight !== undefined ? { fontWeight } : {}),
    ...(strikethrough !== undefined ? { strikethrough } : {}),
    ...(propagate !== undefined ? { propagateToParent: propagate } : {}),
  });
  MERGE_CACHE.set(list, out);
  return out;
}

/**
 * Read the merged decoration for one row, following the current
 * provider snapshot. Cheap — O(1) engine read + cached fold. Safe to
 * call inside a render for every visible row.
 */
export function useFileDecorations(id: EntryId): MergedDecoration {
  // Re-read on every snapshot identity change (useSyncExternalStore
  // upstream already does this). getDecorations is O(1) per engine
  // SPEC §9.4, so inline call is fine.
  const { snapshot } = useFileTreeContext();
  const snap = snapshot as unknown as FileTreeSnapshotLike;
  const list = snap.getDecorations(id);
  return mergeDecorations(list);
}
