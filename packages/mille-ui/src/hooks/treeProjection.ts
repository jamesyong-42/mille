import type { EntryId, VisibleRow, VisibleRowCount } from '@vibecook/mille';
import type { FileTreeSnapshotLike } from '../components/types.js';

/** Structural projection cached independently from decoration snapshots. */
export interface TreeProjection {
  readonly treeVersion: number;
  readonly expanded: ReadonlySet<EntryId>;
  readonly visibleCount: VisibleRowCount;
  readonly rows: readonly VisibleRow[];
}

/**
 * Materialize the complete keyboard projection only when tree structure or
 * expansion identity changes. Decoration-only snapshots deliberately reuse the
 * previous projection, avoiding an O(n) count and row allocation.
 */
export function readTreeProjection(
  snapshot: FileTreeSnapshotLike,
  expanded: ReadonlySet<EntryId>,
  previous: TreeProjection | null,
): TreeProjection {
  if (
    previous !== null &&
    previous.treeVersion === snapshot.treeVersion &&
    previous.expanded === expanded
  ) {
    return previous;
  }

  const visibleCount = snapshot.visibleRowCount(expanded);
  const rows =
    visibleCount.known === 0
      ? []
      : snapshot.visibleRows({
          expanded,
          offset: 0,
          limit: visibleCount.known,
        });
  return {
    treeVersion: snapshot.treeVersion,
    expanded,
    visibleCount,
    rows,
  };
}
