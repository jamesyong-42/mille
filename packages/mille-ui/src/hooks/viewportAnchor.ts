import type { EntryId, VisibleRow } from '@vibecook/mille';

export interface ViewportAnchor {
  readonly id: EntryId;
  readonly index: number;
  /** Distance from the anchored row's top to the viewport's top edge. */
  readonly viewportOffsetPx: number;
}

export interface ViewportAnchorResolution {
  readonly id: EntryId;
  readonly index: number;
  readonly scrollOffsetPx: number;
  readonly usedFallback: boolean;
}

export function captureViewportAnchor(
  rows: readonly VisibleRow[],
  scrollOffsetPx: number,
  rowHeight: number,
): ViewportAnchor | null {
  if (rows.length === 0 || rowHeight <= 0) return null;
  const index = Math.min(rows.length - 1, Math.max(0, Math.floor(scrollOffsetPx / rowHeight)));
  const row = rows[index];
  if (!row) return null;
  return {
    id: row.id,
    index,
    viewportOffsetPx: index * rowHeight - scrollOffsetPx,
  };
}

export function resolveViewportAnchor(
  anchor: ViewportAnchor,
  previousRows: readonly VisibleRow[],
  nextRows: readonly VisibleRow[],
  rowHeight: number,
): ViewportAnchorResolution | null {
  if (nextRows.length === 0 || rowHeight <= 0) return null;

  let id = anchor.id;
  let oldIndex = anchor.index;
  let nextIndex = nextRows.findIndex((row) => row.id === id);
  let usedFallback = false;

  // If the top row disappeared, prefer the next surviving row, then the
  // previous one. Preserve that row's old pixel position, not merely its
  // index, so deletion of the anchor itself does not create a viewport jump.
  if (nextIndex === -1) {
    usedFallback = true;
    const nextIndexById = new Map<EntryId, number>();
    for (let index = 0; index < nextRows.length; index += 1) {
      const row = nextRows[index];
      if (row) nextIndexById.set(row.id, index);
    }
    for (let distance = 1; distance < previousRows.length; distance += 1) {
      const afterIndex = anchor.index + distance;
      const beforeIndex = anchor.index - distance;
      const after = previousRows[afterIndex];
      const before = previousRows[beforeIndex];
      const candidate = after && nextIndexById.has(after.id) ? after : before;
      if (!candidate || !nextIndexById.has(candidate.id)) continue;
      id = candidate.id;
      oldIndex = after === candidate ? afterIndex : beforeIndex;
      nextIndex = nextIndexById.get(id) ?? -1;
      break;
    }
  }

  if (nextIndex === -1) return null;
  const oldViewportOffset = anchor.viewportOffsetPx + (oldIndex - anchor.index) * rowHeight;
  return {
    id,
    index: nextIndex,
    scrollOffsetPx: Math.max(0, nextIndex * rowHeight - oldViewportOffset),
    usedFallback,
  };
}
