// Phase 5.2 — explorer view / scope model.
//
// Views (Open Files, Changed Files, Problems, …) share EntryId identity with
// the project tree but project a flat, ordered list rather than forking
// FileTree. Hosts resolve paths once, then virtualize with ExplorerViewList
// or feed ids into their own list UI.
//
// Multi-root: seeds may carry a known EntryId and/or an absolute rootPath so
// resolution does not collapse every relative path onto a single workspace.

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
 * Pre-resolution seed. Prefer supplying `id` when the host already knows the
 * entry (Open Files tabs). Otherwise supply workspace-relative `path` and
 * optionally `rootPath` for multi-root workspaces.
 */
export interface ExplorerViewSeed {
  /**
   * Workspace-relative POSIX path under `rootPath` (or the resolve default).
   * Used for display and as a stable key component when `id` is absent.
   */
  readonly path: string;
  /**
   * Absolute workspace root this path belongs to. When omitted, the
   * `rootPath` passed to `resolveExplorerView` is used.
   */
  readonly rootPath?: string;
  /**
   * Known engine identity. When set, resolution prefers snapshot lookup by
   * id and only falls back to path resolution if the id is missing from the
   * mirror.
   */
  readonly id?: EntryId;
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
 *
 * `key` is a stable identity for React / virtualizer / selection that works
 * for both resolved and unresolved rows.
 */
export interface ExplorerViewItem {
  /**
   * Stable row identity. Prefer `id:<entryId>` when resolved, otherwise
   * `path:<rootPath>:<relativePath>` (or `path:<relativePath>`).
   */
  readonly key: string;
  readonly id: EntryId | null;
  readonly path: string;
  /** Absolute root used for resolution, when known. */
  readonly rootPath?: string;
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
  /** Paths (or keys) that could not be resolved to an EntryId. */
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
 * Stable sort key for seeds: order asc, then rootPath, then path.
 */
export function sortViewSeeds(
  seeds: readonly ExplorerViewSeed[],
): ExplorerViewSeed[] {
  return [...seeds].sort((a, b) => {
    const ao = a.order ?? 0;
    const bo = b.order ?? 0;
    if (ao !== bo) return ao - bo;
    const ar = a.rootPath ?? '';
    const br = b.rootPath ?? '';
    if (ar !== br) return ar.localeCompare(br);
    return a.path.localeCompare(b.path);
  });
}

/**
 * Stable row key for a seed or item. Prefer EntryId when present so reorder
 * on dirty/active does not remount rows.
 */
export function explorerViewItemKey(input: {
  readonly id?: EntryId | null;
  readonly path: string;
  readonly rootPath?: string;
}): string {
  if (input.id != null) return `id:${input.id}`;
  const root = input.rootPath ?? '';
  return root.length > 0 ? `path:${root}:${input.path}` : `path:${input.path}`;
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
      item.key.toLowerCase().includes(q) ||
      (item.tooltip !== undefined && item.tooltip.toLowerCase().includes(q)),
  );
}
