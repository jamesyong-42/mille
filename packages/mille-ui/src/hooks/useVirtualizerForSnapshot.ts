// useVirtualizerForSnapshot — thin wrapper around `@tanstack/react-virtual`
// that adapts FileTree's materialized visible projection to the virtualizer's
// row-count / key model.
//
// Fixed-height mode in v0.1; the `rowHeight` option can be a number (fixed)
// or a function. Measured mode (variable height) lands alongside the
// row-height callback in a later phase.
//
// Returns only the subset we actually use downstream (virtual items, total
// size, scroll helpers) to keep the Phase 3 surface small.

import type { RefObject } from 'react';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import type { VisibleRow } from '@vibecook/mille';
import type {
  VirtualizerOffsetObserver,
  VirtualizerRectObserver,
} from '../components/types.js';

export type { VirtualizerOffsetObserver, VirtualizerRectObserver };

export interface UseVirtualizerForSnapshotOptions {
  /** Complete visible projection, materialized once by FileTree. */
  readonly visibleRows: readonly VisibleRow[];
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
  readonly scrollOffset: number;
  scrollToIndex(index: number, opts?: { align?: 'start' | 'center' | 'end' | 'auto' }): void;
  measureElement(node: Element | null): void;
}

export function useVirtualizerForSnapshot(
  options: UseVirtualizerForSnapshotOptions,
): UseVirtualizerForSnapshotResult {
  const {
    visibleRows,
    rowHeight,
    overscan,
    scrollerRef,
    observeElementRect,
    observeElementOffset,
  } = options;

  const count = visibleRows.length;

  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => rowHeight,
    overscan,
    getItemKey: (index: number): string | number => {
      // FileTree already materializes the complete projection for keyboard
      // navigation. Reuse it here instead of traversing the snapshot once per
      // virtual item merely to recover a key.
      return visibleRows[index]?.id ?? index;
    },
    ...(observeElementRect ? { observeElementRect } : null),
    ...(observeElementOffset ? { observeElementOffset } : null),
  });

  return {
    count,
    virtualItems: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    scrollOffset: virtualizer.scrollOffset ?? 0,
    scrollToIndex: (index, opts) => {
      virtualizer.scrollToIndex(index, opts);
    },
    measureElement: (node) => {
      virtualizer.measureElement(node);
    },
  };
}
