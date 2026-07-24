// Phase 5.2 — `@vibecook/mille-ui/views` barrel.

export type {
  ExplorerViewDefinition,
  ExplorerViewItem,
  ExplorerViewKind,
  ExplorerViewModel,
  ExplorerViewSeed,
} from './types.js';
export {
  basenamePath,
  dirnamePath,
  explorerViewItemKey,
  filterExplorerViewItems,
  sortViewSeeds,
} from './types.js';

export type {
  ProjectChangedFilesOptions,
  ProjectFailedTestsViewOptions,
  ProjectOpenFilesOptions,
  ProjectProblemsViewOptions,
} from './projectors.js';
export {
  projectChangedFilesView,
  projectCustomScopeView,
  projectFailedTestsView,
  projectOpenFilesView,
  projectProblemsView,
} from './projectors.js';

export type {
  ResolveExplorerViewOptions,
  ViewResolverLike,
} from './resolve.js';
export { resolveExplorerView } from './resolve.js';

export type { ExplorerViewListProps } from './ExplorerViewList.js';
export {
  ExplorerViewList,
  viewBadgeAccessibleLabel,
} from './ExplorerViewList.js';
