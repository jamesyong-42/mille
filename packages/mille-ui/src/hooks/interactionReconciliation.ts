import type { EntryId, VisibleRow } from '@vibecook/mille';

export interface InteractionReconciliation {
  readonly selectedIds: ReadonlySet<EntryId>;
  readonly focusedId: EntryId | null;
  readonly anchorId: EntryId | null;
}

function nearestSurvivor(
  id: EntryId,
  previousRows: readonly VisibleRow[],
  nextIds: ReadonlySet<EntryId>,
): EntryId | null {
  const previousIndex = previousRows.findIndex((row) => row.id === id);
  if (previousIndex === -1) return null;
  for (let distance = 1; distance < previousRows.length; distance += 1) {
    const after = previousRows[previousIndex + distance];
    if (after && nextIds.has(after.id)) return after.id;
    const before = previousRows[previousIndex - distance];
    if (before && nextIds.has(before.id)) return before.id;
  }
  return null;
}

export function reconcileTreeInteraction(
  previousRows: readonly VisibleRow[],
  nextRows: readonly VisibleRow[],
  selectedIds: ReadonlySet<EntryId>,
  focusedId: EntryId | null,
  anchorId: EntryId | null,
): InteractionReconciliation {
  if (selectedIds.size === 0 && focusedId === null && anchorId === null) {
    return { selectedIds, focusedId, anchorId };
  }

  let nextIds: ReadonlySet<EntryId> | null = null;
  const materializeNextIds = (): ReadonlySet<EntryId> => {
    if (nextIds !== null) return nextIds;
    nextIds = new Set(nextRows.map((row) => row.id));
    return nextIds;
  };
  // Most explorer interactions select one or a handful of rows. Avoid a
  // 500k-entry Set allocation for that common path; large selections pay one
  // linear allocation instead of repeatedly scanning the projection.
  if (selectedIds.size > 32) materializeNextIds();
  const hasNext = (id: EntryId): boolean =>
    nextIds !== null ? nextIds.has(id) : nextRows.some((row) => row.id === id);

  let selectionChanged = false;
  const survivingSelection = new Set<EntryId>();
  for (const id of selectedIds) {
    if (hasNext(id)) survivingSelection.add(id);
    else selectionChanged = true;
  }

  const focusSurvives = focusedId === null || hasNext(focusedId);
  const nextFocusedId = focusSurvives
    ? focusedId
    : nearestSurvivor(focusedId, previousRows, materializeNextIds());

  if (
    focusedId !== null &&
    !focusSurvives &&
    selectedIds.has(focusedId) &&
    survivingSelection.size === 0 &&
    nextFocusedId !== null
  ) {
    survivingSelection.add(nextFocusedId);
    selectionChanged = true;
  }

  const nextAnchorId =
    anchorId === null || hasNext(anchorId) ? anchorId : nextFocusedId;

  return {
    selectedIds: selectionChanged ? survivingSelection : selectedIds,
    focusedId: nextFocusedId,
    anchorId: nextAnchorId,
  };
}
