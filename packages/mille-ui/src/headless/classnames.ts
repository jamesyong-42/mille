// Catalog of every `className` the mille-ui styled entry emits.
//
// Consumers of `@vibecook/mille-ui/headless` can use this record to
// author their own stylesheets in a type-safe way — `milleClassNames.row`
// always returns the string the library actually renders. The catalog is
// frozen at module load so it's safe to read across module boundaries.
//
// This list is generated from the real component source (grep for
// `className="mille-"` across `src/components/**`). Keep it in sync when
// you add / rename any class name.

export const milleClassNames = Object.freeze({
  // ─── <FileTree> ────────────────────────────────────────────────────
  tree: 'mille-tree',
  treeContainer: 'mille-tree-container',

  // ─── <FileTreeRow> ────────────────────────────────────────────────
  row: 'mille-row',
  rowName: 'mille-row-name',

  // ─── <IndentGuides> ───────────────────────────────────────────────
  indentGuides: 'mille-indent-guides',
  indentGuide: 'mille-indent-guide',

  // ─── <DisclosureChevron> ──────────────────────────────────────────
  chevron: 'mille-chevron',

  // ─── <LoadingBadge> ───────────────────────────────────────────────
  loadingBadge: 'mille-loading-badge',

  // ─── <FileRenameInput> ────────────────────────────────────────────
  renameInput: 'mille-rename-input',
  renameTooltip: 'mille-rename-tooltip',

  // ─── <FileContextMenu> + <ContextMenuItem> ────────────────────────
  contextMenuContent: 'mille-context-menu-content',
  contextMenuGroup: 'mille-context-menu-group',
  contextMenuSeparator: 'mille-context-menu-separator',
  contextMenuEmpty: 'mille-context-menu-empty',
  contextMenuItem: 'mille-context-menu-item',
  contextMenuItemLabel: 'mille-context-menu-item-label',
  contextMenuItemShortcut: 'mille-context-menu-item-shortcut',

  // ─── <FileDecorations> ────────────────────────────────────────────
  decorations: 'mille-decorations',
  decorationLetter: 'mille-decoration-letter',
  decorationBadge: 'mille-decoration-badge',

  // ─── <FileTreeFilter> ─────────────────────────────────────────────
  filter: 'mille-filter',
  filterInput: 'mille-filter-input',
  filterToggle: 'mille-filter-toggle',

  // ─── <SearchResultList> ───────────────────────────────────────────
  searchList: 'mille-search-list',
  searchOption: 'mille-search-option',
  searchOptionName: 'mille-search-option-name',
  searchOptionPath: 'mille-search-option-path',

  // ─── <FileTreeDragIndicator> ──────────────────────────────────────
  // Drag indicator has no default class — consumers pass `className` in
  // directly. Included for discoverability of the data-attr contract.
  dragIndicator: 'mille-drag-indicator',
});

export type MilleClassNames = typeof milleClassNames;
