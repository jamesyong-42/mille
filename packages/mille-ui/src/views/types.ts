// Phase 5.2 — explorer view / scope model.
//
// Views (Open Files, Changed Files, Problems, …) share EntryId identity with
// the project tree but project a flat, ordered list rather than forking
// FileTree. Hosts resolve paths once, then virtualize with ExplorerViewList
// or feed ids into their own list UI.

import type { EntryId } from '@vibecook/mille';

/**
 * Built-in view kinds. `'custom'` is for host-defined saved scopes.
 */
export type ExplorerViewKind =
  | 'project'
  | 'openFiles'
  | 'changedFiles'
  | 'problems'
  | 'failedTests'
  | 'custom';

/**
 * Pre-resolution seed: workspace-relative path + view metadata.
 * Produced by pure projectors; resolved to EntryId by `resolveExplorerView`.
 */
export interface ExplorerViewSeed {
  readonly path: string;
  /** Stable reason code for filtering / a11y (e.g. `open`, `dirty`, `git:M`). */
  readonly reason: string;
  readonly badge?: string;
  readonly color?: string;
  readonly tooltip?: string;
  /** Optional display override (defaults to basename of path). */
  readonly title?: string;
  /** Sort priority: lower first. Default 0. */
  readonly order?: number;
}

/**
 * Resolved view row. `id` is null when the path is not currently in the
 * mirror (unexpanded lazy tree, deleted file, etc.).
 */
export interface ExplorerViewItem {
  readonly id: EntryId | null;
  readonly path: string;
  readonly name: string;
  readonly reason: string;
  readonly badge?: string;
  readonly color?: string;
  readonly tooltip?: string;
  readonly order: number;
}

/**
 * Materialized view model ready for a virtualized list.
 */
export interface ExplorerViewModel {
  readonly kind: ExplorerViewKind;
  readonly title: string;
  readonly items: readonly ExplorerViewItem[];
  /** Paths that could not be resolved to an EntryId. */
  readonly unresolvedPaths: readonly string[];
}

export interface ExplorerViewDefinition {
  readonly kind: ExplorerViewKind;
  readonly title: string;
  readonly seeds: readonly ExplorerViewSeed[];
}

/** Basename of a workspace-relative POSIX path. */
export function basenamePath(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Parent directory of a workspace-relative path, or `''` for roots. */
export function dirnamePath(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/**
 * Stable sort: order asc, then path localeCompare.
 */
export function sortViewSeeds(
  seeds: readonly ExplorerViewSeed[],
): ExplorerViewSeed[] {
  return [...seeds].sort((a, b) => {
    const ao = a.order ?? 0;
    const bo = b.order ?? 0;
    if (ao !== bo) return ao - bo;
    return a.path.localeCompare(b.path);
  });
}

/**
 * Client-side filter over resolved items (name or path substring).
 */
export function filterExplorerViewItems(
  items: readonly ExplorerViewItem[],
  query: string,
): ExplorerViewItem[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...items];
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      item.path.toLowerCase().includes(q) ||
      item.reason.toLowerCase().includes(q) ||
      (item.tooltip !== undefined && item.tooltip.toLowerCase().includes(q)),
  );
}
