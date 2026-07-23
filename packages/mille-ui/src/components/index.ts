// Components barrel for @vibecook/mille-ui.
//
// The package's top-level `src/index.ts` re-exports from here. Phase
// boundaries keep adding to this list.

export { FileTree } from './FileTree.js';
export { FileTreeRow } from './FileTreeRow.js';
export { DisclosureChevron } from './DisclosureChevron.js';
export { IndentGuides } from './IndentGuides.js';
export { LoadingBadge } from './LoadingBadge.js';
export { FileRenameInput } from './FileRenameInput.js';
export type { FileRenameInputProps } from './FileRenameInput.js';
export { FileContextMenu } from './FileContextMenu.js';
export type { FileContextMenuProps } from './FileContextMenu.js';
export { ContextMenuItem } from './ContextMenuItem.js';
export type { ContextMenuItemProps } from './ContextMenuItem.js';
export { FileDecorations } from './FileDecorations.js';
export type { FileDecorationsProps } from './FileDecorations.js';

// Phase 8 — filter + search.
export { FileTreeFilter } from './FileTreeFilter.js';
export type {
  FileTreeFilterHandle,
  FileTreeFilterMode,
  FileTreeFilterProps,
} from './FileTreeFilter.js';
export { SearchResultList } from './SearchResultList.js';
export type { SearchResultListProps } from './SearchResultList.js';

// Phase 11 — drag-and-drop visual indicator.
export { FileTreeDragIndicator } from './FileTreeDragIndicator.js';
export type { FileTreeDragIndicatorProps } from './FileTreeDragIndicator.js';

export type {
  AriaRowProps,
  DragDropOptions,
  FileTreeEngine,
  FileTreeProps,
  FileTreeRef,
  FileTreeNavigationRestoreResult,
  FileTreeRowProps,
  FileTreeSnapshotLike,
  MergedDecoration,
  VirtualizerOffsetObserver,
  VirtualizerRectObserver,
} from './types.js';

export type { DisclosureChevronProps } from './DisclosureChevron.js';
export type { IndentGuidesProps } from './IndentGuides.js';
export type { LoadingBadgeProps } from './LoadingBadge.js';
