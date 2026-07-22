// @vibecook/mille-ui/headless — logic-only primitives.
//
// v0.2 B8 contract (MILLE_UI_SPEC.md §10.3): the headless entry ships
// the tree's **logic layer** without any JSX. Hooks own ARIA + event
// wiring + state transitions; consumers build their own views.
//
// What the headless tier exports:
//   - Every pre-existing hook in `../hooks/` (all framework-agnostic).
//   - The three v0.2 logic hooks split out of the heavy styled
//     components: `useFileTreeRow`, `useFileRenameInput`,
//     `useFileContextMenu`.
//   - The provider + context + command registry + icon-theme
//     resolution surface (structural, not stylistic).
//   - Component prop types (to compose custom renderers).
//   - The `milleClassNames` catalog (type-safe class-name strings).
//
// What the headless tier **does not** export:
//   - Styled components (`FileTreeRow`, `FileRenameInput`,
//     `FileContextMenu`, `FileTree`, `FileTreeFilter`, `FileDecorations`,
//     `SearchResultList`, `FileTreeDragIndicator`, `DisclosureChevron`,
//     `IndentGuides`, `LoadingBadge`, `ContextMenuItem`,
//     `FileTreeHeadless`). Import those from the default entry
//     `@vibecook/mille-ui` instead.
//   - `FileIcon` (lives under `@vibecook/mille-ui/icons`).
//
// This split keeps `/headless` under the 12 KB gzip budget specified in
// SPEC §12. Consumers who want a full styled tree pay for Radix + the
// icon renderer once, from the default entry. Consumers who want
// zero-CSS build their view against the hooks and skip the JSX payload.

// ─── Hooks (framework-agnostic; no CSS, no Radix) ──────────────────
//
// Re-exports go through the leaf files (not `../hooks/index.js`) so
// the headless entry doesn't drag in sibling hooks the consumer may
// have tree-shaken away. The barrel is safe to use because every
// symbol is a pure ESM `export`, but going to the leaves makes the
// headless-bundle contract explicit — this list is exactly what
// `dist/headless.js` ships.
export { useFileTreeContext } from '../hooks/useFileTreeContext.js';
export { useFileTreeSnapshot } from '../hooks/useFileTreeSnapshot.js';
export {
  useVirtualizerForSnapshot,
  type UseVirtualizerForSnapshotOptions,
  type UseVirtualizerForSnapshotResult,
} from '../hooks/useVirtualizerForSnapshot.js';
export { useExpandedSet, type ExpandedSetHandle } from '../hooks/useExpandedSet.js';
export { useSetExpandedBridge, type SetExpandedFx } from '../hooks/useSetExpandedBridge.js';
export {
  useFileTreeSelection,
  type FileTreeSelectionHandle,
  type UseFileTreeSelectionOptions,
} from '../hooks/useFileTreeSelection.js';
export {
  useFileTreeKeyboard,
  type UseFileTreeKeyboardOptions,
  type UseFileTreeKeyboardResult,
  type KeyboardExpansionActions,
  type KeyboardRowLookup,
  type KeyboardClipboardActions,
  type ViewportKeyboardActions,
} from '../hooks/useFileTreeKeyboard.js';
export {
  useTypeahead,
  type TypeaheadHandle,
  type TypeaheadRowSource,
  type TypeaheadVisibleRow,
  type UseTypeaheadOptions,
} from '../hooks/useTypeahead.js';
export {
  useControlledState,
  type UseControlledStateOptions,
} from '../hooks/useControlledState.js';
export {
  useRenameState,
  type UseRenameStateOptions,
  type RenameStateHandle,
  type RenameStateFx,
  type RenameStateSnapshot,
  type RenameStateControlled,
  type RenameCommitResult,
  type RenameFileSystemError,
} from '../hooks/useRenameState.js';
export {
  useContextMenuState,
  type ContextMenuStateHandle,
} from '../hooks/useContextMenuState.js';
export {
  useFileDecorations,
  mergeDecorations,
  EMPTY_DECORATION,
} from '../hooks/useFileDecorations.js';
export {
  useClipboardState,
  type ClipboardStateHandle,
} from '../hooks/useClipboardState.js';
export {
  useFilterState,
  type FilterStateHandle,
  type UseFilterStateControlled,
  type UseFilterStateOptions,
} from '../hooks/useFilterState.js';
export {
  useSearchResults,
  type SearchableEngine,
  type SearchStatus,
  type UseSearchResultsOptions,
  type UseSearchResultsResult,
} from '../hooks/useSearchResults.js';
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
  type DragDropState,
  type DragDropHandlers,
  type UseFileTreeDragDropResult,
} from '../hooks/useFileTreeDragDrop.js';
export {
  useAutoExpandDwell,
  type AutoExpandDwellHandle,
  type UseAutoExpandDwellOptions,
} from '../hooks/useAutoExpandDwell.js';
export { useFileTreeRef, type FileTreeRef } from '../hooks/useFileTreeRef.js';

// v0.2 B8 — logic hooks extracted from styled components.
export {
  useFileTreeRow,
  type UseFileTreeRowResult,
  type UseFileTreeRowRowProps,
  type UseFileTreeRowChevronProps,
  type UseFileTreeRowIconProps,
  type UseFileTreeRowNameProps,
  type UseFileTreeRowRenameProps,
  type UseFileTreeRowDecorationProps,
} from '../hooks/useFileTreeRow.js';
export {
  useFileRenameInput,
  type UseFileRenameInputOptions,
  type UseFileRenameInputResult,
  type UseFileRenameInputInputProps,
  type UseFileRenameInputTooltipProps,
} from '../hooks/useFileRenameInput.js';
export {
  useFileContextMenu,
  type UseFileContextMenuOptions,
  type UseFileContextMenuResult,
  type UseFileContextMenuGroup,
} from '../hooks/useFileContextMenu.js';


// ─── Provider + context (mount-only; no styling) ───────────────────
export { FileTreeProvider } from '../provider.js';
export type { FileTreeProviderProps } from '../provider.js';
export { FileTreeContext } from '../context.js';
export type { FileTreeContextValue, FileTreeFx } from '../context.js';

// ─── Command registry (pure; no React) ─────────────────────────────
//
// Only the core primitives ship from `/headless` — `createCommandRegistry`
// plus the keybinding + `when` helpers. The bundled default command set
// (`defaultCommands`, `treeDefaults`, `mutationDefaults`) is ~16 KB raw
// on its own and is not a headless-tier concern (it wires specific
// mutation side-effects). Consumers who want it import from
// `@vibecook/mille-ui/commands`.
//
// These re-exports deliberately import from the leaf modules rather
// than the `../commands/index.js` barrel. The barrel re-exports
// `defaultCommands` too, and without `sideEffects: false` published
// esbuild-consumers can't prove the unused exports are dead — going
// straight to the leaves is the portable-tree-shake guarantee.
export { createCommandRegistry } from '../commands/registry.js';
export { evaluateWhen } from '../commands/when.js';
export {
  parseKeybinding,
  matchKeybinding,
  formatKeybinding,
} from '../commands/keybinding.js';
export type { ParsedKeybinding, KeyboardEventLike } from '../commands/keybinding.js';
export type {
  Command,
  CommandContext,
  CommandDisposable,
  CommandRegistry,
  CommandRegistryOptions,
  HostHooks,
} from '../commands/types.js';
export type { CommandRegistryHandle } from '../types.js';

// ─── Icon theme types (resolution surface; no renderer) ────────────
//
// Only the TYPES ship from `/headless` — the actual resolver,
// default-theme payload, and validator live in
// `@vibecook/mille-ui/icons` (where `FileIcon` also lives).
export type {
  IconDefinition,
  IconResolver,
  IconResolverOptions,
  IconTheme,
  IconThemeTokens,
  ResolvedIcon,
} from '../icons/types.js';

// ─── Component prop types (needed to compose custom renderers) ─────
//
// Types-only imports from leaf modules so no component runtime lands
// in the headless bundle. `components/types.ts` is the component prop
// declarations with no React / Radix / icon imports.
export type {
  AriaRowProps,
  DragDropOptions,
  FileTreeEngine,
  FileTreeProps,
  FileTreeRowProps,
  FileTreeSnapshotLike,
  MergedDecoration,
  VirtualizerOffsetObserver,
  VirtualizerRectObserver,
} from '../components/types.js';
export type { DisclosureChevronProps } from '../components/DisclosureChevron.js';
export type { IndentGuidesProps } from '../components/IndentGuides.js';
export type { LoadingBadgeProps } from '../components/LoadingBadge.js';
export type { FileRenameInputProps } from '../components/FileRenameInput.js';
export type { FileContextMenuProps } from '../components/FileContextMenu.js';
export type { ContextMenuItemProps } from '../components/ContextMenuItem.js';
export type { FileDecorationsProps } from '../components/FileDecorations.js';
export type {
  FileTreeFilterHandle,
  FileTreeFilterMode,
  FileTreeFilterProps,
} from '../components/FileTreeFilter.js';
export type { SearchResultListProps } from '../components/SearchResultList.js';
export type { FileTreeDragIndicatorProps } from '../components/FileTreeDragIndicator.js';

// ─── className catalog (type-safe class-name strings) ──────────────
export { milleClassNames, type MilleClassNames } from './classnames.js';
