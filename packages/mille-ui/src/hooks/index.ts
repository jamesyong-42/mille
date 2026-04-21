// Hooks barrel for @vibecook/mille-ui.

export { useFileTreeContext } from './useFileTreeContext.js';
export { useFileTreeSnapshot } from './useFileTreeSnapshot.js';
export {
  useVirtualizerForSnapshot,
  type UseVirtualizerForSnapshotOptions,
  type UseVirtualizerForSnapshotResult,
} from './useVirtualizerForSnapshot.js';
export { useExpandedSet, type ExpandedSetHandle } from './useExpandedSet.js';
export { useSetExpandedBridge, type SetExpandedFx } from './useSetExpandedBridge.js';

// Phase 4 — selection, keyboard, typeahead, controlled-state helpers.
export {
  useFileTreeSelection,
  type FileTreeSelectionHandle,
  type UseFileTreeSelectionOptions,
} from './useFileTreeSelection.js';
export {
  useFileTreeKeyboard,
  type UseFileTreeKeyboardOptions,
  type UseFileTreeKeyboardResult,
  type KeyboardExpansionActions,
  type KeyboardRowLookup,
  type KeyboardClipboardActions,
  type ViewportKeyboardActions,
} from './useFileTreeKeyboard.js';
export {
  useTypeahead,
  type TypeaheadHandle,
  type TypeaheadVisibleRow,
  type UseTypeaheadOptions,
} from './useTypeahead.js';
export {
  useControlledState,
  type UseControlledStateOptions,
} from './useControlledState.js';

// Phase 5 — rename + create state.
export {
  useRenameState,
  type UseRenameStateOptions,
  type RenameStateHandle,
  type RenameStateFx,
  type RenameStateSnapshot,
  type RenameStateControlled,
  type RenameCommitResult,
  type RenameFileSystemError,
} from './useRenameState.js';

// Phase 6 — context menu state.
export {
  useContextMenuState,
  type ContextMenuStateHandle,
} from './useContextMenuState.js';

// Phase 10 — decorations pipeline.
export {
  useFileDecorations,
  mergeDecorations,
  EMPTY_DECORATION,
} from './useFileDecorations.js';

// Phase 7 — in-app clipboard (cut / copy / paste).
export {
  useClipboardState,
  type ClipboardStateHandle,
} from './useClipboardState.js';

// Phase 8 — filter state + search-results hook.
export {
  useFilterState,
  type FilterStateHandle,
  type UseFilterStateControlled,
  type UseFilterStateOptions,
} from './useFilterState.js';
export {
  useSearchResults,
  type SearchableEngine,
  type SearchStatus,
  type UseSearchResultsOptions,
  type UseSearchResultsResult,
} from './useSearchResults.js';

// Phase 11 — drag-and-drop coordinator + auto-expand dwell helper.
export {
  useFileTreeDragDrop,
  MIME_URI_LIST,
  MIME_MILLE_ENTRIES,
  MIME_CLAUDE_ATTACHMENT,
  MIME_TEXT_PLAIN,
  type DragDropEffect,
  type DropPosition,
  type DragDropValidateContext,
  type DragDropValidationResult,
  type DragDropOptions,
  type DragDropState,
  type DragDropHandlers,
  type UseFileTreeDragDropResult,
} from './useFileTreeDragDrop.js';
export {
  useAutoExpandDwell,
  type AutoExpandDwellHandle,
  type UseAutoExpandDwellOptions,
} from './useAutoExpandDwell.js';

// v0.2 B6 — imperative tree handle.
export { useFileTreeRef } from './useFileTreeRef.js';
export type { FileTreeRef } from './useFileTreeRef.js';

// v0.2 B8 — logic hooks extracted from heavy styled components so
// `@vibecook/mille-ui/headless` can expose them without bundling the
// Radix / icon subsystems that the styled views depend on.
export {
  useFileTreeRow,
  type UseFileTreeRowResult,
  type UseFileTreeRowRowProps,
  type UseFileTreeRowChevronProps,
  type UseFileTreeRowIconProps,
  type UseFileTreeRowNameProps,
  type UseFileTreeRowRenameProps,
  type UseFileTreeRowDecorationProps,
} from './useFileTreeRow.js';
export {
  useFileRenameInput,
  type UseFileRenameInputOptions,
  type UseFileRenameInputResult,
  type UseFileRenameInputInputProps,
  type UseFileRenameInputTooltipProps,
} from './useFileRenameInput.js';
export {
  useFileContextMenu,
  type UseFileContextMenuOptions,
  type UseFileContextMenuResult,
  type UseFileContextMenuGroup,
} from './useFileContextMenu.js';
