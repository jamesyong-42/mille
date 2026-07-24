// Phase 5.2 — virtualized flat list for explorer views (Open Files,
// Problems, …). Shares EntryId identity with the project tree; does not
// reimplement FileTree hierarchy.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { EntryId } from '@vibecook/mille';
import type { ExplorerViewItem, ExplorerViewModel } from './types.js';
import { filterExplorerViewItems } from './types.js';

export interface ExplorerViewListProps {
  readonly model: ExplorerViewModel;
  readonly rowHeight?: number;
  readonly overscan?: number;
  /** Client-side filter over name/path/reason. */
  readonly filterQuery?: string;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly emptyState?: ReactNode;
  /** Called when the user activates a resolved row (Enter / double-click). */
  onOpen?(item: ExplorerViewItem): void;
  /** Called when selection changes (arrow keys / click). */
  onSelect?(item: ExplorerViewItem | null): void;
  /** Optional controlled selected entry id. */
  readonly selectedId?: EntryId | null;
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

const ROW_STYLE: CSSProperties = {
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
  flex: '0 1 auto',
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const PATH_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  opacity: 0.55,
  fontSize: '0.9em',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const BADGE_STYLE: CSSProperties = {
  flex: '0 0 auto',
  fontSize: '0.75em',
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
};

export function ExplorerViewList(props: ExplorerViewListProps): ReactElement {
  const {
    model,
    rowHeight = 22,
    overscan = 8,
    filterQuery = '',
    ariaLabel,
    className,
    style,
    emptyState,
    onOpen,
    onSelect,
    selectedId: controlledSelectedId,
  } = props;

  const items = useMemo(
    () => filterExplorerViewItems(model.items, filterQuery),
    [model.items, filterQuery],
  );

  const parentRef = useRef<HTMLDivElement | null>(null);
  const [internalSelected, setInternalSelected] = useState<EntryId | null>(
    null,
  );
  const selectedId =
    controlledSelectedId !== undefined
      ? controlledSelectedId
      : internalSelected;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  const selectAt = useCallback(
    (index: number) => {
      const item = items[index];
      if (item === undefined) return;
      if (controlledSelectedId === undefined) {
        setInternalSelected(item.id);
      }
      onSelect?.(item);
    },
    [items, controlledSelectedId, onSelect],
  );

  const openAt = useCallback(
    (index: number) => {
      const item = items[index];
      if (item === undefined || item.id === null) return;
      onOpen?.(item);
    },
    [items, onOpen],
  );

  // Keep selection index in range when the list shrinks.
  useEffect(() => {
    if (selectedId === null) return;
    if (!items.some((i) => i.id === selectedId)) {
      if (controlledSelectedId === undefined) setInternalSelected(null);
    }
  }, [items, selectedId, controlledSelectedId]);

  const selectedIndex = useMemo(() => {
    if (selectedId === null) return -1;
    return items.findIndex((i) => i.id === selectedId);
  }, [items, selectedId]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (items.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next =
          selectedIndex < 0
            ? 0
            : Math.min(items.length - 1, selectedIndex + 1);
        selectAt(next);
        virtualizer.scrollToIndex(next);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        const next =
          selectedIndex < 0
            ? items.length - 1
            : Math.max(0, selectedIndex - 1);
        selectAt(next);
        virtualizer.scrollToIndex(next);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (selectedIndex >= 0) openAt(selectedIndex);
      } else if (event.key === 'Home') {
        event.preventDefault();
        selectAt(0);
        virtualizer.scrollToIndex(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        const last = items.length - 1;
        selectAt(last);
        virtualizer.scrollToIndex(last);
      }
    },
    [items.length, selectedIndex, selectAt, openAt, virtualizer],
  );

  if (items.length === 0) {
    return (
      <div
        className={
          className
            ? `mille-explorer-view-list mille-explorer-view-empty ${className}`
            : 'mille-explorer-view-list mille-explorer-view-empty'
        }
        style={style}
        role="status"
        aria-label={ariaLabel ?? model.title}
      >
        {emptyState ?? (
          <div style={{ padding: '12px 8px', opacity: 0.65 }}>
            No items in {model.title}
          </div>
        )}
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className={
        className
          ? `mille-explorer-view-list ${className}`
          : 'mille-explorer-view-list'
      }
      style={{ ...LIST_STYLE, ...style }}
      role="listbox"
      aria-label={ariaLabel ?? model.title}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-mille-explorer-view={model.kind}
    >
      <div style={INNER_STYLE(virtualizer.getTotalSize())}>
        {virtualItems.map((vRow) => {
          const item = items[vRow.index];
          if (item === undefined) return null;
          const selected = item.id !== null && item.id === selectedId;
          const unresolved = item.id === null;
          return (
            <div
              key={`${item.path}:${vRow.index}`}
              role="option"
              aria-selected={selected}
              aria-disabled={unresolved || undefined}
              data-mille-view-path={item.path}
              data-mille-view-reason={item.reason}
              data-mille-view-unresolved={unresolved ? '' : undefined}
              title={item.tooltip}
              style={{
                ...ROW_STYLE,
                height: `${vRow.size}px`,
                transform: `translateY(${vRow.start}px)`,
                background: selected
                  ? 'var(--mille-row-bg-selected, color-mix(in oklch, currentColor 12%, transparent))'
                  : undefined,
                opacity: unresolved ? 0.55 : 1,
              }}
              onClick={() => selectAt(vRow.index)}
              onDoubleClick={() => openAt(vRow.index)}
            >
              {item.badge !== undefined ? (
                <span
                  className="mille-explorer-view-badge"
                  style={{
                    ...BADGE_STYLE,
                    ...(item.color !== undefined ? { color: item.color } : {}),
                  }}
                  aria-hidden="true"
                >
                  {item.badge}
                </span>
              ) : null}
              <span className="mille-explorer-view-name" style={NAME_STYLE}>
                {item.name}
              </span>
              <span className="mille-explorer-view-path" style={PATH_STYLE}>
                {item.path}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
