// FileTreeHeadless — namespace grouping the tree's structural components
// under a headless-oriented contract.
//
// v0.1 pragmatic scope: these are the SAME components as the styled
// entry (`@vibecook/mille-ui`), re-exported here so consumers targeting
// `/headless` can import everything through a single namespace and know
// the library treats styling as their responsibility. Each component's
// only presentational output is:
//
//   - `className="mille-..."` hooks (see `./classnames.ts` for the
//     exhaustive list) — override via CSS.
//   - Layout-critical inline styles (absolute positioning for virtualized
//     rows, flex for row layout, overflow on scrollers). These are the
//     load-bearing styles a consumer MUST NOT strip.
//   - CSS variable-gated colors (e.g. `var(--mille-chevron-color,
//     currentColor)`), which consumers override via their own stylesheet
//     without needing to replace the components.
//
// v0.2+ (SPEC §4.9): a full logic-hook / thin-view split per component.
// See MILLE_UI_PLAN.md Phase 16 for the refinement pass.

import {
  FileTree,
  FileTreeRow,
  DisclosureChevron,
  IndentGuides,
  LoadingBadge,
  FileRenameInput,
  FileContextMenu,
  ContextMenuItem,
  FileDecorations,
  FileTreeFilter,
  SearchResultList,
  FileTreeDragIndicator,
} from '../components/index.js';
import { FileIcon } from '../icons/FileIcon.js';

/**
 * Compound headless namespace. Each member is the corresponding styled
 * component from the top-level entry; under the headless contract their
 * ARIA, event handlers, and structural DOM are guaranteed stable while
 * styling is delegated to the consumer via `className` overrides (see
 * `milleClassNames`) and CSS custom properties.
 */
export const FileTreeHeadless = {
  Root: FileTree,
  Row: FileTreeRow,
  Icon: FileIcon,
  Decorations: FileDecorations,
  RenameInput: FileRenameInput,
  ContextMenu: FileContextMenu,
  ContextMenuItem: ContextMenuItem,
  Filter: FileTreeFilter,
  SearchResults: SearchResultList,
  DragIndicator: FileTreeDragIndicator,
  IndentGuides: IndentGuides,
  DisclosureChevron: DisclosureChevron,
  LoadingBadge: LoadingBadge,
} as const;
