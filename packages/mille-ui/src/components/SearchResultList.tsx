// SearchResultList — virtualized ranked search view used by `<FileTree>`
// when `searchMode === 'search'` and the filter text is non-empty.
//
// Phase 8. Replaces the tree DOM with a `role="listbox"` whose options
// are `SearchHit`s returned by `fx.search(query, { limit })`. Arrow keys
// move selection; Enter dispatches a permanent search open intent.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import type { EntryId, SearchHit } from '@vibecook/mille';
import {
  PERMANENT_SEARCH_OPEN,
  type FileOpenEvent,
} from '../open-policy.js';
import {
  useSearchResults,
  type SearchableEngine,
  type UseSearchResultsResult,
} from '../hooks/useSearchResults.js';
import type {
  VirtualizerOffsetObserver,
  VirtualizerRectObserver,
} from './types.js';

export interface SearchResultListProps {
  readonly fx: SearchableEngine;
  readonly query: string;
  readonly limit?: number;
  readonly rowHeight?: number;
  readonly overscan?: number;
  /** Called when the user presses Enter or double-clicks a hit. */
  onOpen?(entryId: EntryId, event: FileOpenEvent): void;
  /** Rendered when `query` is non-empty but no hits came back. */
  readonly emptyState?: ReactNode;
  /** Rendered while a search is in flight. */
  readonly loadingState?: ReactNode;
  /** Rendered on engine error. */
  readonly errorState?: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly ariaLabel?: string;
  /**
   * Testing-only virtualizer observers. See `FileTreeProps`.
   */
  readonly __testObserveElementRect?: VirtualizerRectObserver;
  readonly __testObserveElementOffset?: VirtualizerOffsetObserver;
  /** Debounce override. See `useSearchResults`. */
  readonly debounceMs?: number;
}

const LIST_STYLE: CSSProperties = {
  height: '100%',
  overflow: 'auto',
  position: 'relative',
  outline: 'none',
};

const INNER_STYLE = (totalSize: number): CSSProperties => ({
  height: `${totalSize}px`,
  position: 'relative',
  width: '100%',
});

const ROW_BASE_STYLE: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '0 8px',
  boxSizing: 'border-box',
  cursor: 'default',
  userSelect: 'none',
};

const NAME_STYLE: CSSProperties = {
  flex: '0 0 auto',
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const PATH_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  opacity: 0.65,
  fontSize: '0.92em',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const MATCH_STYLE: CSSProperties = {
  fontWeight: 700,
};

/**
 * Return the "path" string for a hit. The engine's `SearchHit.entry`
 * exposes `pathSegments` (compact-folders) and `name`; when path is
 * not directly available we fall back to `name`.
 */
function formatPath(hit: SearchHit): string {
  const entry = hit.entry;
  if (entry.pathSegments && entry.pathSegments.length > 0) {
    return entry.pathSegments.join('/');
  }
  return entry.name;
}

/**
 * Render a name span with bold chars at every position in `indices`.
 * Indices that fall outside the name length are tolerated (tests often
 * supply full-path indices).
 */
function renderMatched(name: string, indices: readonly number[]): ReactElement {
  if (!indices || indices.length === 0) {
    return <span>{name}</span>;
  }
  const hits = new Set<number>(indices);
  const chunks: ReactElement[] = [];
  // Group runs of matched / unmatched chars so the DOM stays compact.
  let i = 0;
  let key = 0;
  while (i < name.length) {
    const isMatch = hits.has(i);
    let j = i + 1;
    while (j < name.length && hits.has(j) === isMatch) j += 1;
    const slice = name.slice(i, j);
    if (isMatch) {
      chunks.push(
        <span key={key} style={MATCH_STYLE} data-mille-search-match="true">
          {slice}
        </span>,
      );
    } else {
      chunks.push(<span key={key}>{slice}</span>);
    }
    key += 1;
    i = j;
  }
  return <>{chunks}</>;
}

export function SearchResultList(props: SearchResultListProps): ReactElement {
  const {
    fx,
    query,
    limit = 100,
    rowHeight = 28,
    overscan = 10,
    onOpen,
    emptyState,
    loadingState,
    errorState,
    className,
    style,
    ariaLabel = 'Search results',
    __testObserveElementRect,
    __testObserveElementOffset,
    debounceMs,
  } = props;

  const searchState: UseSearchResultsResult = useSearchResults({
    fx,
    query,
    limit,
    enabled: query !== '',
    ...(debounceMs !== undefined ? { debounceMs } : {}),
  });

  const hits = searchState.hits;

  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: hits.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => rowHeight,
    overscan,
    getItemKey: (index: number): string | number => {
      const hit = hits[index];
      return hit ? hit.entry.id : index;
    },
    ...(__testObserveElementRect ? { observeElementRect: __testObserveElementRect } : null),
    ...(__testObserveElementOffset ? { observeElementOffset: __testObserveElementOffset } : null),
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // ─── Selection within the result list ──────────────────────────────
  //
  // Index-based to avoid ambiguity when identical entries appear
  // multiple times in search results (rare, but possible for two roots
  // with the same path suffix).
  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  // Reset selection to the top whenever the underlying results change.
  useEffect(() => {
    setSelectedIndex(0);
  }, [hits]);

  // Clamp selection whenever `hits` shrinks.
  useEffect(() => {
    if (hits.length === 0) {
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex((prev) => (prev >= hits.length ? hits.length - 1 : prev));
  }, [hits.length]);

  const openIndex = useCallback(
    (idx: number) => {
      const hit = hits[idx];
      if (!hit || !onOpen) return;
      onOpen(hit.entry.id, PERMANENT_SEARCH_OPEN);
    },
    [hits, onOpen],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (hits.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, hits.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        setSelectedIndex(0);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        setSelectedIndex(hits.length - 1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        openIndex(selectedIndex);
        return;
      }
    },
    [hits, openIndex, selectedIndex],
  );

  const rows = useMemo<ReactElement[]>(() => {
    const out: ReactElement[] = [];
    for (const vItem of virtualItems) {
      const hit = hits[vItem.index];
      if (!hit) continue;
      const isSelected = vItem.index === selectedIndex;
      out.push(renderRow(vItem, hit, isSelected, rowHeight, openIndex, setSelectedIndex));
    }
    return out;
  }, [virtualItems, hits, selectedIndex, rowHeight, openIndex]);

  // ─── Render states ────────────────────────────────────────────────
  if (query === '') {
    // Rare: parent shouldn't mount us with empty query, but be defensive.
    return (
      <div
        className={className ? `mille-search-list ${className}` : 'mille-search-list'}
        data-mille-search-state="idle"
        style={style ? { ...LIST_STYLE, ...style } : LIST_STYLE}
      />
    );
  }

  if (searchState.status === 'loading') {
    return (
      <div
        className={className ? `mille-search-list ${className}` : 'mille-search-list'}
        data-mille-search-state="loading"
        style={style ? { ...LIST_STYLE, ...style } : LIST_STYLE}
      >
        {loadingState ?? <div style={{ padding: '8px' }}>Searching...</div>}
      </div>
    );
  }

  if (searchState.status === 'error') {
    return (
      <div
        className={className ? `mille-search-list ${className}` : 'mille-search-list'}
        data-mille-search-state="error"
        data-mille-search-error={searchState.error?.message ?? 'Unknown error'}
        style={style ? { ...LIST_STYLE, ...style } : LIST_STYLE}
      >
        {errorState ?? <div style={{ padding: '8px' }}>Search failed.</div>}
      </div>
    );
  }

  if (hits.length === 0) {
    return (
      <div
        className={className ? `mille-search-list ${className}` : 'mille-search-list'}
        data-mille-search-state="empty"
        style={style ? { ...LIST_STYLE, ...style } : LIST_STYLE}
      >
        {emptyState ?? <div style={{ padding: '8px', opacity: 0.7 }}>No results.</div>}
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      role="listbox"
      aria-label={ariaLabel}
      className={className ? `mille-search-list ${className}` : 'mille-search-list'}
      data-mille-search-state="ready"
      data-mille-search-hit-count={hits.length}
      style={style ? { ...LIST_STYLE, ...style } : LIST_STYLE}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div style={INNER_STYLE(totalSize)}>{rows}</div>
    </div>
  );
}

function renderRow(
  vItem: VirtualItem,
  hit: SearchHit,
  isSelected: boolean,
  rowHeight: number,
  openIndex: (idx: number) => void,
  setSelectedIndex: (idx: number) => void,
): ReactElement {
  const name = hit.entry.name;
  const pathText = formatPath(hit);

  const rowStyle: CSSProperties = {
    ...ROW_BASE_STYLE,
    height: `${rowHeight}px`,
    transform: `translateY(${vItem.start}px)`,
    background: isSelected
      ? 'var(--mille-search-selected-bg, color-mix(in oklch, currentColor 14%, transparent))'
      : undefined,
  };

  const onClick = (_e: ReactMouseEvent<HTMLDivElement>): void => {
    setSelectedIndex(vItem.index);
  };
  const onDoubleClick = (_e: ReactMouseEvent<HTMLDivElement>): void => {
    openIndex(vItem.index);
  };

  return (
    <div
      key={vItem.key}
      role="option"
      aria-selected={isSelected}
      data-mille-search-option-id={hit.entry.id}
      data-mille-search-option-index={vItem.index}
      data-mille-search-option-selected={isSelected ? 'true' : undefined}
      className="mille-search-option"
      style={rowStyle}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <span className="mille-search-option-name" style={NAME_STYLE}>
        {renderMatched(name, hit.matchedIndices)}
      </span>
      <span className="mille-search-option-path" style={PATH_STYLE}>
        {pathText}
      </span>
    </div>
  );
}

SearchResultList.displayName = 'SearchResultList';
