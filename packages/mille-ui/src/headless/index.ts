// @vibecook/mille-ui/headless — unstyled primitives + hooks.
//
// This entry is a PRAGMATIC v0.1 headless surface: it re-exports the
// full hook layer (framework-agnostic by construction), the command
// registry + icons-resolver types, and a `FileTreeHeadless` namespace
// whose members are the same structural components as the styled entry
// — the library's styling contract is `className="mille-..."` hooks
// (see `milleClassNames`) + CSS-variable-gated colors. Consumers who
// want to restyle from scratch import from here; consumers who accept
// mille-ui's shipped look import from the top-level entry.
//
// v0.2+ (SPEC §4.9): a full logic-hook / thin-view split per styled
// component. See MILLE_UI_PLAN.md Phase 16.
//
// Note: nothing here ships colors, borders, or padding beyond what the
// virtualizer + flex-row layout strictly requires. Check the audit in
// the Phase 12 report and `./README.md` for the list of load-bearing
// inline styles every component preserves.

// ─── Hooks (framework-agnostic; no CSS) ────────────────────────────
export {
  useFileTreeContext,
  useFileTreeSnapshot,
  useVirtualizerForSnapshot,
  useExpandedSet,
  useSetExpandedBridge,
  useFileTreeSelection,
  useFileTreeKeyboard,
  useTypeahead,
  useControlledState,
  useRenameState,
  useContextMenuState,
  useFileDecorations,
  mergeDecorations,
  EMPTY_DECORATION,
  useClipboardState,
  useFilterState,
  useSearchResults,
  useFileTreeDragDrop,
  useAutoExpandDwell,
  MIME_URI_LIST,
  MIME_MILLE_ENTRIES,
  MIME_CLAUDE_ATTACHMENT,
  MIME_TEXT_PLAIN,
} from '../hooks/index.js';
export type {
  UseVirtualizerForSnapshotOptions,
  UseVirtualizerForSnapshotResult,
  ExpandedSetHandle,
  SetExpandedFx,
  FileTreeSelectionHandle,
  UseFileTreeSelectionOptions,
  UseFileTreeKeyboardOptions,
  UseFileTreeKeyboardResult,
  KeyboardExpansionActions,
  KeyboardRowLookup,
  KeyboardClipboardActions,
  ViewportKeyboardActions,
  TypeaheadHandle,
  TypeaheadVisibleRow,
  UseTypeaheadOptions,
  UseControlledStateOptions,
  UseRenameStateOptions,
  RenameStateHandle,
  RenameStateFx,
  RenameStateSnapshot,
  RenameStateControlled,
  RenameCommitResult,
  RenameFileSystemError,
  ContextMenuStateHandle,
  ClipboardStateHandle,
  FilterStateHandle,
  UseFilterStateControlled,
  UseFilterStateOptions,
  SearchableEngine,
  SearchStatus,
  UseSearchResultsOptions,
  UseSearchResultsResult,
  DragDropEffect,
  DropPosition,
  DragDropValidateContext,
  DragDropValidationResult,
  DragDropState,
  DragDropHandlers,
  UseFileTreeDragDropResult,
  AutoExpandDwellHandle,
  UseAutoExpandDwellOptions,
} from '../hooks/index.js';

// ─── Provider + context (mount-only; no styling) ───────────────────
export { FileTreeProvider } from '../provider.js';
export type { FileTreeProviderProps } from '../provider.js';
export { FileTreeContext } from '../context.js';
export type { FileTreeContextValue, FileTreeFx } from '../context.js';

// ─── Command registry (pure; no React) ─────────────────────────────
export {
  createCommandRegistry,
  evaluateWhen,
  parseKeybinding,
  matchKeybinding,
  formatKeybinding,
  defaultCommands,
  treeDefaults,
  mutationDefaults,
} from '../commands/index.js';
export type {
  ParsedKeybinding,
  KeyboardEventLike,
  Command,
  CommandContext,
  CommandDisposable,
  CommandRegistry,
  CommandRegistryOptions,
  HostHooks,
} from '../commands/index.js';
export type { CommandRegistryHandle } from '../types.js';

// ─── Icon theme types (resolution surface; no renderer) ────────────
export type {
  IconDefinition,
  IconResolver,
  IconResolverOptions,
  IconTheme,
  IconThemeTokens,
  ResolvedIcon,
} from '../icons/types.js';
export { createIconResolver } from '../icons/resolver.js';
export { defaultIconTheme } from '../icons/default-theme.js';
export { validateIconTheme, IconThemeValidationError } from '../icons/schema.js';

// ─── Component prop types (needed to compose custom renderers) ─────
export type {
  AriaRowProps,
  DragDropOptions,
  DisclosureChevronProps,
  FileTreeEngine,
  FileTreeProps,
  FileTreeRowProps,
  FileTreeSnapshotLike,
  IndentGuidesProps,
  LoadingBadgeProps,
  MergedDecoration,
  VirtualizerOffsetObserver,
  VirtualizerRectObserver,
  FileRenameInputProps,
  FileContextMenuProps,
  ContextMenuItemProps,
  FileDecorationsProps,
  FileTreeFilterHandle,
  FileTreeFilterMode,
  FileTreeFilterProps,
  SearchResultListProps,
  FileTreeDragIndicatorProps,
} from '../components/index.js';

// ─── Headless namespace + className catalog ────────────────────────
export { FileTreeHeadless } from './FileTreeHeadless.js';
export { milleClassNames, type MilleClassNames } from './classnames.js';
