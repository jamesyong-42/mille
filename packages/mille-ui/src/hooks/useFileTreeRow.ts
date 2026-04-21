// useFileTreeRow — logic hook behind the `<FileTreeRow>` default view.
//
// Phase B8 of V0_2_PLAN.md (headless trim 22 KB → 12 KB).
//
// The styled `<FileTreeRow>` previously baked ARIA, event wiring, rename
// state, DnD prop routing, and the sticky-root / hidden / decoration
// attributes directly into its JSX. That made `@vibecook/mille-ui/headless`
// inherit the full Radix + icons + styled-row payload even though
// consumers of `/headless` only want the logic layer.
//
// This hook exposes the same behaviour as prop bundles ready to spread
// onto a consumer-owned JSX tree. The styled view in
// `components/FileTreeRow.tsx` now calls `useFileTreeRow()` and does
// nothing else but spread the bundles onto its DOM nodes.
//
// No JSX, no icon imports, no Radix imports — the hook's only
// dependency is React.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { EntryId } from '@vibecook/mille';
import type { AriaRowProps, FileTreeRowProps } from '../components/types.js';

// Numeric enum matching api.d.ts §EntryKind.
const KIND_DIRECTORY = 1;

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

const NAME_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

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

/**
 * Prop bundle for the row's outer `<div role="treeitem">`. Spread
 * directly onto a `<div>` or compatible component.
 *
 * Includes the `ref` callback that wires up `registerRowElement`. Any
 * drag handlers the tree omitted (DnD off) are omitted here too.
 */
export interface UseFileTreeRowRowProps {
  readonly ref: (el: HTMLDivElement | null) => void;
  readonly role: 'treeitem';
  readonly 'aria-level': number;
  readonly 'aria-setsize'?: number;
  readonly 'aria-posinset'?: number;
  readonly 'aria-selected': boolean;
  readonly 'aria-expanded'?: boolean;
  readonly 'data-mille-row-id': EntryId;
  readonly 'data-mille-depth': number;
  readonly 'data-mille-selected'?: 'true';
  readonly 'data-mille-focused'?: 'true';
  readonly 'data-mille-pending'?: 'true';
  readonly 'data-mille-sticky-root'?: 'true';
  readonly 'data-mille-cut'?: 'true';
  readonly 'data-mille-hidden'?: 'true';
  readonly 'data-mille-dragging'?: 'true';
  readonly 'data-mille-drop-target-self'?: 'true';
  readonly 'data-mille-drop-target-above'?: 'true';
  readonly 'data-mille-drop-target-below'?: 'true';
  readonly 'data-mille-decoration-ignored'?: 'true';
  readonly 'data-mille-decoration-strikethrough'?: 'true';
  readonly className?: string;
  readonly style: CSSProperties;
  readonly tabIndex: 0 | -1;
  readonly draggable?: true;
  readonly onClick: (e: ReactMouseEvent<HTMLElement>) => void;
  readonly onDoubleClick: (e: ReactMouseEvent<HTMLElement>) => void;
  readonly onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
  readonly onKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void;
  readonly onFocus?: (e: ReactFocusEvent<HTMLElement>) => void;
  readonly onDragStart?: (e: ReactDragEvent<HTMLElement>) => void;
  readonly onDragEnter?: (e: ReactDragEvent<HTMLElement>) => void;
  readonly onDragOver?: (e: ReactDragEvent<HTMLElement>) => void;
  readonly onDragLeave?: (e: ReactDragEvent<HTMLElement>) => void;
  readonly onDrop?: (e: ReactDragEvent<HTMLElement>) => void;
  readonly onDragEnd?: (e: ReactDragEvent<HTMLElement>) => void;
}

/** Prop bundle for the row's disclosure chevron. */
export interface UseFileTreeRowChevronProps {
  readonly expanded: boolean;
  readonly hasChildren: boolean;
  readonly onClick: (e: ReactMouseEvent<HTMLElement>) => void;
}

/** Prop bundle for the row's file icon. */
export interface UseFileTreeRowIconProps {
  readonly entry: FileTreeRowProps['row'];
  readonly expanded: boolean;
  readonly rootLevel: boolean;
}

/** Prop bundle for the row's name `<span>` (or equivalent). */
export interface UseFileTreeRowNameProps {
  readonly className: 'mille-row-name';
  readonly 'data-mille-row-name': '';
  readonly style: CSSProperties;
  readonly children: string;
}

/**
 * Prop bundle for the inline rename input. `null` when this row isn't
 * currently being renamed (the common case). Consumers can treat `null`
 * as "render the name, not the input".
 */
export interface UseFileTreeRowRenameProps {
  readonly initialName: string;
  readonly kind: 'file' | 'directory';
  readonly onCommit: (newName: string) => void;
  readonly onCancel: () => void;
  readonly validator?: (newName: string) => string | null;
  readonly errorTooltip?: string;
}

/** Prop bundle for the decoration overlay. */
export interface UseFileTreeRowDecorationProps {
  readonly decorations: FileTreeRowProps['decorations'];
}

/**
 * Result of `useFileTreeRow`. Every field is a prop bundle ready to
 * spread onto the corresponding DOM node or sub-component. `renameProps`
 * is `null` when the row isn't being renamed.
 */
export interface UseFileTreeRowResult {
  readonly rowProps: UseFileTreeRowRowProps;
  readonly chevronProps: UseFileTreeRowChevronProps;
  readonly iconProps: UseFileTreeRowIconProps;
  readonly nameProps: UseFileTreeRowNameProps;
  readonly renameProps: UseFileTreeRowRenameProps | null;
  readonly decorationProps: UseFileTreeRowDecorationProps;
  readonly ariaProps: AriaRowProps;
  /** `true` when the row shows `<LoadingBadge>` — same as `props.pending`. */
  readonly pending: boolean;
  /** Wrap the row in a context-menu root? Same as `!props.disableContextMenu`. */
  readonly useContextMenuWrapper: boolean;
  /** `true` when the row should wire drag handlers. */
  readonly dndEnabled: boolean;
  /** Computed `depth` for child helpers (indent guides, etc.). */
  readonly depth: number;
}

/**
 * Pure-logic hook behind `<FileTreeRow>`. Accepts the same prop surface
 * as the component; returns prop bundles and a few flags the view needs
 * to decide between shapes (rename vs name, with-menu vs without).
 */
export function useFileTreeRow(props: FileTreeRowProps): UseFileTreeRowResult {
  const {
    row,
    depth,
    selected,
    focused,
    expanded,
    hasChildren,
    pending,
    decorations,
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

  const dndEnabled = disableDragDrop !== true;

  const rowStyle: CSSProperties = useMemo(() => {
    return {
      ...ROW_BASE_STYLE,
      paddingInlineStart: `calc(${depth} * var(--mille-indent-size, 8px))`,
      height: 'var(--mille-row-height, 22px)',
      ...(isStickyRoot
        ? {
            position: 'sticky' as const,
            top: 0,
            zIndex: 1,
            background:
              'var(--mille-sticky-root-bg, var(--mille-row-bg, transparent))',
          }
        : null),
      ...style,
      ...(hidden ? { display: 'none' as const } : null),
    };
  }, [depth, isStickyRoot, style, hidden]);

  const rowProps = useMemo<UseFileTreeRowRowProps>(() => {
    const t = 'true' as const;
    const out: Record<string, unknown> = {
      ref: setRowEl,
      role: 'treeitem',
      'aria-level': ariaProps['aria-level'],
      'aria-selected': selected,
      'data-mille-row-id': row.id,
      'data-mille-depth': depth,
      className: cx('mille-row', className),
      style: rowStyle,
      tabIndex: focused ? 0 : -1,
      onClick,
      onDoubleClick,
      onContextMenu,
    };
    if (ariaProps['aria-setsize'] !== undefined) out['aria-setsize'] = ariaProps['aria-setsize'];
    if (ariaProps['aria-posinset'] !== undefined) out['aria-posinset'] = ariaProps['aria-posinset'];
    if (hasChildren) out['aria-expanded'] = expanded;
    if (selected) out['data-mille-selected'] = t;
    if (focused) out['data-mille-focused'] = t;
    if (pending) out['data-mille-pending'] = t;
    if (isStickyRoot) out['data-mille-sticky-root'] = t;
    if (cut) out['data-mille-cut'] = t;
    if (hidden) out['data-mille-hidden'] = t;
    if (dragging) out['data-mille-dragging'] = t;
    if (dropTargetPosition === 'self') out['data-mille-drop-target-self'] = t;
    else if (dropTargetPosition === 'above') out['data-mille-drop-target-above'] = t;
    else if (dropTargetPosition === 'below') out['data-mille-drop-target-below'] = t;
    if (decorations.fontWeight === 0) out['data-mille-decoration-ignored'] = t;
    if (decorations.strikethrough) out['data-mille-decoration-strikethrough'] = t;
    if (dndEnabled) {
      out.draggable = true;
      if (onDragStart) out.onDragStart = onDragStart;
      if (onDragEnter) out.onDragEnter = onDragEnter;
      if (onDragOver) out.onDragOver = onDragOver;
      if (onDragLeave) out.onDragLeave = onDragLeave;
      if (onDrop) out.onDrop = onDrop;
      if (onDragEnd) out.onDragEnd = onDragEnd;
    }
    if (onKeyDown) out.onKeyDown = onKeyDown;
    if (onFocus) out.onFocus = onFocus;
    return out as unknown as UseFileTreeRowRowProps;
  }, [
    setRowEl,
    ariaProps,
    selected,
    row.id,
    depth,
    className,
    rowStyle,
    focused,
    onClick,
    onDoubleClick,
    onContextMenu,
    hasChildren,
    expanded,
    pending,
    isStickyRoot,
    cut,
    hidden,
    dragging,
    dropTargetPosition,
    decorations.fontWeight,
    decorations.strikethrough,
    dndEnabled,
    onKeyDown,
    onFocus,
    onDragStart,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
  ]);

  const chevronProps: UseFileTreeRowChevronProps = {
    expanded,
    hasChildren,
    onClick: onChevronClick,
  };

  const iconProps: UseFileTreeRowIconProps = {
    entry: row,
    expanded,
    rootLevel: depth === 0,
  };

  const nameProps: UseFileTreeRowNameProps = {
    className: 'mille-row-name',
    'data-mille-row-name': '',
    style: NAME_STYLE,
    children: displayName,
  };

  const renameProps: UseFileTreeRowRenameProps | null = isRenaming
    ? {
        initialName: row.name,
        kind: row.kind === KIND_DIRECTORY ? 'directory' : 'file',
        onCommit: onRenameCommit!,
        onCancel: onRenameCancel!,
        ...(validateRename ? { validator: validateRename } : null),
        ...(renameError !== undefined && renameError !== null
          ? { errorTooltip: renameError }
          : null),
      }
    : null;

  const decorationProps: UseFileTreeRowDecorationProps = { decorations };

  return {
    rowProps,
    chevronProps,
    iconProps,
    nameProps,
    renameProps,
    decorationProps,
    ariaProps,
    pending,
    useContextMenuWrapper: !disableContextMenu,
    dndEnabled,
    depth,
  };
}

// (DropPosition is re-exported separately from the hooks barrel via the
// DnD module; avoid a redundant alias here to keep the gzip footprint
// of the headless entry small.)
