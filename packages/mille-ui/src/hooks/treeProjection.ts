import type { EntryId, VisibleRow, VisibleRowCount } from '@vibecook/mille';
import type { FileTreeSnapshotLike } from '../components/types.js';

/** Structural projection cached independently from decoration snapshots. */
export interface TreeProjection {
  readonly treeVersion: number;
  readonly projectionVersion: number;
  readonly expanded: ReadonlySet<EntryId>;
  readonly visibleCount: VisibleRowCount;
  /** Read a bounded slice for the mounted virtual window. */
  readRows(offset: number, limit: number): readonly VisibleRow[];
  /** Lazily materialize full order for discrete keyboard/imperative commands. */
  readAllRows(): readonly VisibleRow[];
}

/**
 * Build a lazy structural projection when tree structure or expansion identity
 * changes. Decoration-only snapshots reuse the previous projection. Ordinary
 * rendering reads only a virtual window; complete ordering is paid only by
 * discrete commands that explicitly request it.
 */
export function readTreeProjection(
  snapshot: FileTreeSnapshotLike,
  expanded: ReadonlySet<EntryId>,
  previous: TreeProjection | null,
): TreeProjection {
  const projectionVersion = snapshot.projectionVersion ?? snapshot.treeVersion;
  if (
    previous !== null &&
    previous.treeVersion === snapshot.treeVersion &&
    previous.projectionVersion === projectionVersion &&
    previous.expanded === expanded
  ) {
    return previous;
  }

  const visibleCount = snapshot.visibleRowCount(expanded);
  let cachedWindow:
    | { readonly offset: number; readonly limit: number; readonly rows: readonly VisibleRow[] }
    | null = null;
  let cachedAllRows: readonly VisibleRow[] | null = visibleCount.known === 0 ? [] : null;
  const readRows = (offset: number, limit: number): readonly VisibleRow[] => {
    const safeOffset = Math.max(0, Math.min(visibleCount.known, Math.trunc(offset)));
    const safeLimit = Math.max(
      0,
      Math.min(visibleCount.known - safeOffset, Math.trunc(limit)),
    );
    if (safeLimit === 0) return [];
    if (cachedAllRows !== null) return cachedAllRows.slice(safeOffset, safeOffset + safeLimit);
    if (cachedWindow?.offset === safeOffset && cachedWindow.limit === safeLimit) {
      return cachedWindow.rows;
    }
    const rows = snapshot.visibleRows({ expanded, offset: safeOffset, limit: safeLimit });
    cachedWindow = { offset: safeOffset, limit: safeLimit, rows };
    return rows;
  };
  const readAllRows = (): readonly VisibleRow[] => {
    if (cachedAllRows === null) {
      cachedAllRows = snapshot.visibleRows({
        expanded,
        offset: 0,
        limit: visibleCount.known,
      });
    }
    return cachedAllRows;
  };
  return {
    treeVersion: snapshot.treeVersion,
    projectionVersion,
    expanded,
    visibleCount,
    readRows,
    readAllRows,
  };
}
