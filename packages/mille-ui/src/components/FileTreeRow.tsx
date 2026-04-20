// FileTreeRow — the default row renderer.
//
// Structure per MILLE_UI_SPEC.md §4.3:
//
//   <div role="treeitem" aria-level aria-selected aria-expanded>
//     <IndentGuides depth={depth} />
//     <DisclosureChevron expanded hasChildren />
//     <FileIcon entry={entry} expanded={expanded} />
//     <span className="mille-row-name">{displayName}</span>
//     {pending && <LoadingBadge />}
//     {/* decoration slot — Phase 10 fills */}
//   </div>
//
// Wrapped in `React.memo` keyed on identifying props; re-renders only
// when ids / versions / flags change. Phase-10 will replace the
// decoration placeholder and feed a per-row decoration-version into the
// memo key.

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { FileIcon, defaultIconTheme } from '../icons/index.js';
import type { FileTreeRowProps } from './types.js';
import { DisclosureChevron } from './DisclosureChevron.js';
import { IndentGuides } from './IndentGuides.js';
import { LoadingBadge } from './LoadingBadge.js';
import { FileRenameInput } from './FileRenameInput.js';
import { FileDecorations } from './FileDecorations.js';

// Numeric enum matching api.d.ts §EntryKind.
const KIND_DIRECTORY = 1;

// Tiny class-name helper — saves pulling in `clsx`. Filters out false /
// undefined / null, then space-joins.
function cx(...parts: ReadonlyArray<string | false | null | undefined>): string | undefined {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    out = out ? `${out} ${p}` : p;
  }
  return out || undefined;
}

const NAME_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

// Base style. Virtualizer supplies absolute positioning via `style`.
const ROW_BASE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  boxSizing: 'border-box',
  width: '100%',
  position: 'relative',
  userSelect: 'none',
};

function FileTreeRowImpl(props: FileTreeRowProps): ReactElement {
  const {
    row,
    depth,
    selected,
    focused,
    expanded,
    hasChildren,
    pending,
    decorations,
    iconTheme,
    className,
    style,
    ariaProps,
    isStickyRoot,
    cut,
    hidden,
    onChevronClick,
    onClick,
    onDoubleClick,
    onContextMenu,
    onKeyDown,
    onFocus,
    renameTargetId,
    onRenameCommit,
    onRenameCancel,
    validateRename,
    renameError,
    disableContextMenu,
    contextMenuContent,
    registerRowElement,
    disableDragDrop,
    dragging,
    dropTargetPosition,
    onDragStart,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
  } = props;

  // Row DOM ref. Published up through `registerRowElement` so the
  // tree's keyboard handler can synthesize `contextmenu` events here
  // when Shift+F10 / Menu is pressed.
  const rowElRef = useRef<HTMLDivElement | null>(null);
  const setRowEl = useCallback(
    (el: HTMLDivElement | null) => {
      rowElRef.current = el;
      if (registerRowElement) registerRowElement(row.id, el);
    },
    [registerRowElement, row.id],
  );
  useEffect(() => {
    // Ensure cleanup if the row unmounts without the ref callback
    // firing with `null` (which does run in React, but being explicit
    // keeps the registry tidy when a consumer remounts aggressively).
    return () => {
      if (registerRowElement) registerRowElement(row.id, null);
    };
  }, [registerRowElement, row.id]);

  const displayName =
    row.pathSegments && row.pathSegments.length > 0
      ? row.pathSegments.join('/')
      : row.name;

  const isRenaming =
    renameTargetId !== undefined &&
    renameTargetId !== null &&
    renameTargetId === row.id &&
    typeof onRenameCommit === 'function' &&
    typeof onRenameCancel === 'function';

  const rowStyle: CSSProperties = {
    ...ROW_BASE_STYLE,
    paddingInlineStart: `calc(${depth} * var(--mille-indent-size, 8px))`,
    height: 'var(--mille-row-height, 22px)',
    ...(isStickyRoot
      ? {
          position: 'sticky',
          top: 0,
          zIndex: 1,
          background: 'var(--mille-sticky-root-bg, var(--mille-row-bg, transparent))',
        }
      : null),
    ...style,
    ...(hidden ? { display: 'none' } : null),
  };

  // Phase 11 — DnD wiring. A row is draggable unless the row-level or
  // tree-level `disableDragDrop` prop is set. Handlers are only
  // attached when the tree provided them (i.e. DnD is active).
  const dndEnabled = disableDragDrop !== true;

  const rowNode: ReactNode = (
    <div
      ref={setRowEl}
      role="treeitem"
      aria-level={ariaProps['aria-level']}
      {...(ariaProps['aria-setsize'] !== undefined
        ? { 'aria-setsize': ariaProps['aria-setsize'] }
        : null)}
      {...(ariaProps['aria-posinset'] !== undefined
        ? { 'aria-posinset': ariaProps['aria-posinset'] }
        : null)}
      aria-selected={selected}
      {...(hasChildren ? { 'aria-expanded': expanded } : null)}
      data-mille-row-id={row.id}
      data-mille-depth={depth}
      data-mille-selected={selected ? 'true' : undefined}
      data-mille-focused={focused ? 'true' : undefined}
      data-mille-pending={pending ? 'true' : undefined}
      data-mille-sticky-root={isStickyRoot ? 'true' : undefined}
      data-mille-cut={cut ? 'true' : undefined}
      data-mille-hidden={hidden ? 'true' : undefined}
      data-mille-dragging={dragging ? 'true' : undefined}
      data-mille-drop-target-self={
        dropTargetPosition === 'self' ? 'true' : undefined
      }
      data-mille-drop-target-above={
        dropTargetPosition === 'above' ? 'true' : undefined
      }
      data-mille-drop-target-below={
        dropTargetPosition === 'below' ? 'true' : undefined
      }
      data-mille-decoration-ignored={
        decorations.fontWeight === 0 ? 'true' : undefined
      }
      data-mille-decoration-strikethrough={
        decorations.strikethrough ? 'true' : undefined
      }
      className={cx('mille-row', className)}
      style={rowStyle}
      tabIndex={focused ? 0 : -1}
      {...(dndEnabled ? { draggable: true } : null)}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      {...(onKeyDown ? { onKeyDown } : null)}
      {...(onFocus ? { onFocus } : null)}
      {...(dndEnabled && onDragStart ? { onDragStart } : null)}
      {...(dndEnabled && onDragEnter ? { onDragEnter } : null)}
      {...(dndEnabled && onDragOver ? { onDragOver } : null)}
      {...(dndEnabled && onDragLeave ? { onDragLeave } : null)}
      {...(dndEnabled && onDrop ? { onDrop } : null)}
      {...(dndEnabled && onDragEnd ? { onDragEnd } : null)}
    >
      <IndentGuides depth={depth} />
      <DisclosureChevron
        expanded={expanded}
        hasChildren={hasChildren}
        onClick={onChevronClick}
      />
      <FileIcon
        entry={row}
        expanded={expanded}
        theme={iconTheme ?? defaultIconTheme}
        rootLevel={depth === 0}
      />
      {isRenaming ? (
        <FileRenameInput
          initialName={row.name}
          kind={row.kind === KIND_DIRECTORY ? 'directory' : 'file'}
          onCommit={onRenameCommit!}
          onCancel={onRenameCancel!}
          {...(validateRename ? { validator: validateRename } : null)}
          {...(renameError !== undefined && renameError !== null
            ? { errorTooltip: renameError }
            : null)}
        />
      ) : (
        <span className="mille-row-name" data-mille-row-name="" style={NAME_STYLE}>
          {displayName}
        </span>
      )}
      {pending ? <LoadingBadge /> : null}
      <FileDecorations decorations={decorations} />
    </div>
  );

  // Phase 6: each row gets its own Radix <ContextMenu.Root>. Radix's
  // anchor-at-cursor behavior keys off the Root that captured the real
  // contextmenu event, so a per-row Root matches VS Code / Finder
  // semantics (menu always anchors where the click happened, even when
  // the user switches between rows quickly).
  if (disableContextMenu) {
    return <>{rowNode}</>;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{rowNode}</ContextMenu.Trigger>
      {contextMenuContent !== undefined && contextMenuContent !== null
        ? contextMenuContent
        : null}
    </ContextMenu.Root>
  );
}

/**
 * Row memoization.
 *
 * Phase 10 refines this: the comparator checks **data identity** of the
 * props that drive what the row actually renders (row entry, depth,
 * flags, decorations, aria, rename state). Callback props (`onClick`,
 * `onRenameCommit`, etc.) are intentionally NOT compared — the parent
 * tree recreates them as inline closures on every render, but their
 * *behavior* is keyed on stable, externally-owned state (`row`,
 * `selection`, `renameState`). Comparing their identity would defeat
 * the memo on every tree re-render and turn a decoration-only snapshot
 * bump into a 500-row re-render storm (SPEC §12 target: < 4 ms).
 *
 * `style` is also deliberately NOT in the equality check — the
 * virtualizer supplies a fresh style object per render, but its top /
 * transform reflects position, which is unrelated to the row's
 * identity. The outer FileTree always structures the list so rows that
 * actually moved get a changed `row` identity.
 *
 * The `decorations` identity check is the load-bearing Phase 10 piece:
 * `mergeDecorations` returns a stable reference when the underlying
 * `readonly Decoration[]` is unchanged, so decoration-only snapshot
 * bumps only disturb rows whose decorations actually changed.
 */
export const FileTreeRow = memo(FileTreeRowImpl, (prev, next) => {
  return (
    prev.row === next.row &&
    prev.depth === next.depth &&
    prev.selected === next.selected &&
    prev.focused === next.focused &&
    prev.expanded === next.expanded &&
    prev.hasChildren === next.hasChildren &&
    prev.pending === next.pending &&
    prev.iconTheme === next.iconTheme &&
    prev.className === next.className &&
    prev.isStickyRoot === next.isStickyRoot &&
    prev.cut === next.cut &&
    prev.hidden === next.hidden &&
    prev.decorations === next.decorations &&
    prev.renameTargetId === next.renameTargetId &&
    prev.renameError === next.renameError &&
    prev.disableContextMenu === next.disableContextMenu &&
    prev.contextMenuContent === next.contextMenuContent &&
    // Phase 11 — DnD visual state. Without these, `data-mille-dragging`
    // and `data-mille-drop-target-*` would never reflect changes because
    // the Phase-10 memo would skip re-renders during a drag.
    prev.dragging === next.dragging &&
    prev.dropTargetPosition === next.dropTargetPosition &&
    prev.disableDragDrop === next.disableDragDrop
  );
});
FileTreeRow.displayName = 'FileTreeRow';
