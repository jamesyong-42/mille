// FileTreeRow — the default row renderer.
//
// Phase B8 (v0.2): this component is now a **thin view** on top of the
// `useFileTreeRow` logic hook. The hook owns ARIA + event wiring +
// rename / DnD / decoration state; the view spreads the returned prop
// bundles onto its DOM nodes and sub-components.
//
// Structure per MILLE_UI_SPEC.md §4.3:
//
//   <div role="treeitem" aria-level aria-selected aria-expanded>
//     <IndentGuides depth={depth} />
//     <DisclosureChevron expanded hasChildren />
//     <FileIcon entry={entry} expanded={expanded} />
//     <span className="mille-row-name">{displayName}</span>
//     {pending && <LoadingBadge />}
//     <FileDecorations decorations={decorations} />
//   </div>
//
// Wrapped in `React.memo` keyed on identifying props; re-renders only
// when ids / versions / flags change.

import { memo, type ReactElement, type ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { FileIcon, defaultIconTheme } from '../icons/index.js';
import { useFileTreeRow } from '../hooks/useFileTreeRow.js';
import type { FileTreeRowProps } from './types.js';
import { DisclosureChevron } from './DisclosureChevron.js';
import { IndentGuides } from './IndentGuides.js';
import { LoadingBadge } from './LoadingBadge.js';
import { FileRenameInput } from './FileRenameInput.js';
import { FileDecorations } from './FileDecorations.js';

function FileTreeRowImpl(props: FileTreeRowProps): ReactElement {
  const {
    rowProps,
    chevronProps,
    iconProps,
    nameProps,
    renameProps,
    decorationProps,
    pending,
    useContextMenuWrapper,
    depth,
  } = useFileTreeRow(props);

  const iconTheme = props.iconTheme ?? defaultIconTheme;

  // Layout matches JetBrains Project view:
  //   chevron · icon · VCS badge · name · loading
  // (decorations sit before the name, not trailing right).
  const rowNode: ReactNode = (
    <div {...rowProps}>
      <IndentGuides depth={depth} />
      <DisclosureChevron {...chevronProps} />
      <FileIcon {...iconProps} theme={iconTheme} />
      <FileDecorations {...decorationProps} />
      {renameProps !== null ? (
        <FileRenameInput {...renameProps} />
      ) : (
        <span {...nameProps} />
      )}
      {pending ? <LoadingBadge /> : null}
    </div>
  );

  // Phase 6: each row gets its own Radix <ContextMenu.Root>. Radix's
  // anchor-at-cursor behavior keys off the Root that captured the real
  // contextmenu event, so a per-row Root matches VS Code / Finder
  // semantics (menu always anchors where the click happened, even when
  // the user switches between rows quickly).
  if (!useContextMenuWrapper) {
    return <>{rowNode}</>;
  }

  const contextMenuContent = props.contextMenuContent;
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
