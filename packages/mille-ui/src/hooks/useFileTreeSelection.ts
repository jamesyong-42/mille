// useFileTreeSelection — local selection + focus state for the tree.
//
// Phase-4 primitive. Matches MILLE_UI_SPEC.md §6.4 multi-select semantics:
//
//   - "Focused" and "selected" are independent. The focused row is the
//     one that currently has keyboard focus (roving tabindex). Selected
//     rows are the ones the user has picked via click / space / arrow-shift.
//   - Anchor tracks the last `selectOne` or `selectRange` endpoint. It's
//     the reference point for subsequent range selections.
//   - `selectRange` needs the visible-id list from the caller because
//     the "distance" between two rows is measured visually (flattened
//     visible rows), not structurally.
//
// The hook supports both uncontrolled (internal state) and controlled
// (props wire through `useControlledState`) modes. The returned setters
// always fire onChange; controlled callers re-render via the new props.

import { useCallback, useMemo, useRef } from 'react';
import type { EntryId } from '@vibecook/mille';
import { useControlledState } from './useControlledState.js';

export interface UseFileTreeSelectionOptions {
  /** Initial selection for the uncontrolled branch. Ignored if `selectedIds` is set. */
  readonly initialSelected?: ReadonlySet<EntryId> | Iterable<EntryId>;
  /** Initial focus for the uncontrolled branch. Ignored if `focusedId` is set. */
  readonly initialFocused?: EntryId | null;

  // Controlled-mode props — when provided, state is owned by the caller.
  readonly selectedIds?: ReadonlySet<EntryId> | undefined;
  readonly onSelectionChange?: (ids: ReadonlySet<EntryId>) => void;
  readonly focusedId?: EntryId | null | undefined;
  readonly onFocusedIdChange?: (id: EntryId | null) => void;
}

export interface FileTreeSelectionHandle {
  readonly selectedIds: ReadonlySet<EntryId>;
  readonly focusedId: EntryId | null;
  /** Replace selection with [id] and update anchor + focus. */
  selectOne(id: EntryId): void;
  /**
   * Replace selection with the inclusive range [fromId, toId] measured
   * against the caller-supplied flat visible-id list. Updates anchor
   * (fromId) and focus (toId). If either id is missing from the list,
   * the selection is left unchanged.
   */
  selectRange(
    fromId: EntryId,
    toId: EntryId,
    allVisibleIds: readonly EntryId[],
  ): void;
  /** Toggle a single id in the selection. Updates anchor to id. */
  toggle(id: EntryId): void;
  /** Drop every selected id. Does not change focus. */
  clear(): void;
  /** Update the focused id without touching selection. */
  setFocused(id: EntryId | null): void;
  /** Replace selection directly (used by Cmd+A / clear). */
  setSelection(ids: ReadonlySet<EntryId>): void;
  /** Current anchor, if any. Read-only; mutated by selectOne / selectRange / toggle. */
  readonly anchorId: EntryId | null;
}

const EMPTY_SET: ReadonlySet<EntryId> = Object.freeze(new Set<EntryId>());

function toReadonlySet(
  input: ReadonlySet<EntryId> | Iterable<EntryId> | undefined,
): ReadonlySet<EntryId> {
  if (!input) return EMPTY_SET;
  if (input instanceof Set) return input;
  const s = new Set<EntryId>();
  for (const id of input) s.add(id);
  return s;
}

export function useFileTreeSelection(
  options: UseFileTreeSelectionOptions = {},
): FileTreeSelectionHandle {
  const {
    initialSelected,
    initialFocused = null,
    selectedIds,
    onSelectionChange,
    focusedId,
    onFocusedIdChange,
  } = options;

  const defaultSelected = useMemo<ReadonlySet<EntryId>>(
    () => toReadonlySet(initialSelected),
    // We only want to seed this once; subsequent renders never re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [selection, setSelection] = useControlledState<ReadonlySet<EntryId>>({
    value: selectedIds,
    defaultValue: defaultSelected,
    ...(onSelectionChange ? { onChange: onSelectionChange } : {}),
  });

  const [focused, setFocusedInternal] = useControlledState<EntryId | null>({
    value: focusedId,
    defaultValue: initialFocused,
    ...(onFocusedIdChange ? { onChange: onFocusedIdChange } : {}),
  });

  // Anchor lives in a ref — it's neither selection nor focus, it's a
  // separate bookkeeping value that survives re-renders.
  const anchorRef = useRef<EntryId | null>(null);

  const selectOne = useCallback(
    (id: EntryId) => {
      const next = new Set<EntryId>();
      next.add(id);
      setSelection(next);
      setFocusedInternal(id);
      anchorRef.current = id;
    },
    [setSelection, setFocusedInternal],
  );

  const toggle = useCallback(
    (id: EntryId) => {
      const next = new Set(selection);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      setSelection(next);
      setFocusedInternal(id);
      anchorRef.current = id;
    },
    [selection, setSelection, setFocusedInternal],
  );

  const selectRange = useCallback(
    (fromId: EntryId, toId: EntryId, allVisibleIds: readonly EntryId[]) => {
      const fromIdx = allVisibleIds.indexOf(fromId);
      const toIdx = allVisibleIds.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1) return;
      const lo = Math.min(fromIdx, toIdx);
      const hi = Math.max(fromIdx, toIdx);
      const next = new Set<EntryId>();
      for (let i = lo; i <= hi; i += 1) {
        const id = allVisibleIds[i];
        if (id !== undefined) next.add(id);
      }
      setSelection(next);
      setFocusedInternal(toId);
      // Anchor stays at `fromId` — the range's stable endpoint.
      anchorRef.current = fromId;
    },
    [setSelection, setFocusedInternal],
  );

  const clear = useCallback(() => {
    if (selection.size === 0) return;
    setSelection(EMPTY_SET);
  }, [selection, setSelection]);

  const setFocused = useCallback(
    (id: EntryId | null) => {
      setFocusedInternal(id);
    },
    [setFocusedInternal],
  );

  const setSelectionDirect = useCallback(
    (ids: ReadonlySet<EntryId>) => {
      setSelection(ids);
    },
    [setSelection],
  );

  // Expose a getter for the anchor ref so tests (and keyboard handler)
  // can observe it without a re-render. We purposely don't surface the
  // raw ref — callers read via `anchorId` from the handle.
  return useMemo<FileTreeSelectionHandle>(
    () => ({
      selectedIds: selection,
      focusedId: focused,
      get anchorId() {
        return anchorRef.current;
      },
      selectOne,
      selectRange,
      toggle,
      clear,
      setFocused,
      setSelection: setSelectionDirect,
    }),
    [selection, focused, selectOne, selectRange, toggle, clear, setFocused, setSelectionDirect],
  );
}
