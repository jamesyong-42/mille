// useVirtualizerForSnapshot — thin wrapper around `@tanstack/react-virtual`
// that adapts a `MirrorSnapshot` + expanded-id set to the virtualizer's
// row-count / key model.
//
// Fixed-height mode in v0.1; the `rowHeight` option can be a number (fixed)
// or a function. Measured mode (variable height) lands alongside the
// row-height callback in a later phase.
//
// Returns only the subset we actually use downstream (virtual items, total
// size, scroll helpers) to keep the Phase 3 surface small.

import { useMemo, type RefObject } from 'react';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import type { EntryId, VisibleRow } from '@vibecook/mille';
import type {
  FileTreeSnapshotLike,
  VirtualizerOffsetObserver,
  VirtualizerRectObserver,
} from '../components/types.js';

export type { VirtualizerOffsetObserver, VirtualizerRectObserver };

export interface UseVirtualizerForSnapshotOptions {
  readonly snapshot: FileTreeSnapshotLike;
  readonly expanded: ReadonlySet<EntryId>;
  readonly rowHeight: number;
  readonly overscan: number;
  readonly scrollerRef: RefObject<HTMLElement | null>;
  /**
   * Optional rect observer override. Production callers leave this
   * `undefined` to use virtual-core's default (ResizeObserver-based
   * reader of `offsetWidth`/`offsetHeight`). Useful for tests under
   * happy-dom where the default path returns zero dimensions.
   */
  readonly observeElementRect?: VirtualizerRectObserver;
  /**
   * Optional offset observer override. Same rationale as
   * `observeElementRect`.
   */
  readonly observeElementOffset?: VirtualizerOffsetObserver;
}

export interface UseVirtualizerForSnapshotResult {
  readonly count: number;
  readonly virtualItems: readonly VirtualItem[];
  readonly totalSize: number;
  scrollToIndex(index: number, opts?: { align?: 'start' | 'center' | 'end' | 'auto' }): void;
  measureElement(node: Element | null): void;
}

export function useVirtualizerForSnapshot(
  options: UseVirtualizerForSnapshotOptions,
): UseVirtualizerForSnapshotResult {
  const {
    snapshot,
    expanded,
    rowHeight,
    overscan,
    scrollerRef,
    observeElementRect,
    observeElementOffset,
  } = options;

  // `count` depends only on the snapshot identity and the expanded set.
  // We recompute defensively (cheap; the snapshot caches it).
  const count = useMemo(
    () => snapshot.visibleRowCount(expanded).known,
    [snapshot, expanded],
  );

  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => rowHeight,
    overscan,
    getItemKey: (index: number): string | number => {
      // Pull a single row to learn its id. The real engine implements this
      // in O(log n); the fake engine does a slice. If the slot is pending
      // (not yet materialized), fall back to the index.
      const rows: readonly VisibleRow[] = snapshot.visibleRows({
        expanded,
        offset: index,
        limit: 1,
      });
      const first = rows[0];
      return first ? first.id : index;
    },
    ...(observeElementRect ? { observeElementRect } : null),
    ...(observeElementOffset ? { observeElementOffset } : null),
  });

  return {
    count,
    virtualItems: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    scrollToIndex: (index, opts) => {
      virtualizer.scrollToIndex(index, opts);
    },
    measureElement: (node) => {
      virtualizer.measureElement(node);
    },
  };
}
