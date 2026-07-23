import type { Entry, EntryId } from '@vibecook/mille';

export const FILE_TREE_NAVIGATION_STATE_VERSION = 1 as const;
export const FILE_TREE_NAVIGATION_LIMITS = Object.freeze({
  expandedPaths: 4_096,
  selectedPaths: 1_024,
  pathLength: 4_096,
  filterLength: 4_096,
  maxDepth: 128,
});

export type FileTreeSearchMode = 'off' | 'filter' | 'search';

export interface FileTreeScrollAnchor {
  readonly path: string;
  readonly offsetPx: number;
}

/**
 * Stable, path-based navigation state. Entry ids are deliberately absent:
 * native ids are allocated per process and are not safe across restarts.
 */
export interface FileTreeNavigationState {
  readonly version: typeof FILE_TREE_NAVIGATION_STATE_VERSION;
  readonly expandedPaths: readonly string[];
  readonly selectedPaths: readonly string[];
  readonly focusedPath: string | null;
  readonly filter: string;
  readonly searchMode: FileTreeSearchMode;
  readonly scrollAnchor: FileTreeScrollAnchor | null;
}

export interface FileTreeNavigationSnapshot {
  getById(id: EntryId): Entry | null;
}

export interface CaptureFileTreeNavigationStateOptions {
  readonly snapshot: FileTreeNavigationSnapshot;
  readonly expandedIds: ReadonlySet<EntryId>;
  readonly selectedIds: ReadonlySet<EntryId>;
  readonly focusedId: EntryId | null;
  readonly filter: string;
  readonly searchMode: FileTreeSearchMode;
  readonly scrollAnchor?: {
    readonly id: EntryId;
    readonly offsetPx: number;
  } | null;
}

function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= FILE_TREE_NAVIGATION_LIMITS.pathLength &&
    !value.includes('\0')
  );
}

function boundedPaths(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const candidate of value) {
    if (!validPath(candidate)) continue;
    unique.add(candidate);
    if (unique.size >= limit) break;
  }
  return [...unique].sort();
}

function searchMode(value: unknown): FileTreeSearchMode {
  return value === 'filter' || value === 'search' ? value : 'off';
}

function scrollAnchor(value: unknown): FileTreeScrollAnchor | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!validPath(record.path)) return null;
  const rawOffset = record.offsetPx;
  return {
    path: record.path,
    offsetPx:
      typeof rawOffset === 'number' && Number.isFinite(rawOffset)
        ? Math.max(0, rawOffset)
        : 0,
  };
}

/**
 * Resolve and migrate persisted input. Version 0 was the pre-release,
 * unversioned path shape; accepting it gives hosts a deterministic migration
 * path without preserving unstable numeric ids.
 */
export function parseFileTreeNavigationState(
  input: string | unknown,
): FileTreeNavigationState | null {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 0 && record.version !== 1) {
    return null;
  }

  const expandedPaths = boundedPaths(
    record.expandedPaths ?? record.expanded,
    FILE_TREE_NAVIGATION_LIMITS.expandedPaths,
  );
  const selectedPaths = boundedPaths(
    record.selectedPaths ?? record.selected,
    FILE_TREE_NAVIGATION_LIMITS.selectedPaths,
  );
  const focusedCandidate = record.focusedPath ?? record.focused;
  const filterCandidate = typeof record.filter === 'string' ? record.filter : '';

  return Object.freeze({
    version: FILE_TREE_NAVIGATION_STATE_VERSION,
    expandedPaths: Object.freeze(expandedPaths),
    selectedPaths: Object.freeze(selectedPaths),
    focusedPath: validPath(focusedCandidate) ? focusedCandidate : null,
    filter: filterCandidate.slice(0, FILE_TREE_NAVIGATION_LIMITS.filterLength),
    searchMode: searchMode(record.searchMode),
    scrollAnchor: scrollAnchor(record.scrollAnchor),
  });
}

/** Stable key order makes disk diffs and deterministic tests readable. */
export function serializeFileTreeNavigationState(
  state: FileTreeNavigationState,
): string {
  const normalized = parseFileTreeNavigationState(state);
  if (normalized === null) {
    throw new TypeError('Invalid file-tree navigation state');
  }
  return JSON.stringify(normalized);
}

/** Build a root-qualified workspace path from the hydrated parent chain. */
export function fileTreePathForId(
  snapshot: FileTreeNavigationSnapshot,
  id: EntryId,
): string | null {
  const segments: string[] = [];
  const seen = new Set<EntryId>();
  let cursor: EntryId | null = id;
  while (cursor !== null && segments.length < FILE_TREE_NAVIGATION_LIMITS.maxDepth) {
    if (seen.has(cursor)) return null;
    seen.add(cursor);
    const entry = snapshot.getById(cursor);
    if (entry === null || entry.name.length === 0 || entry.name.includes('/')) return null;
    segments.push(entry.name);
    cursor = entry.parentId;
  }
  if (cursor !== null || segments.length === 0) return null;
  const path = segments.reverse().join('/');
  return validPath(path) ? path : null;
}

function pathsForIds(
  snapshot: FileTreeNavigationSnapshot,
  ids: ReadonlySet<EntryId>,
  limit: number,
): string[] {
  const paths = new Set<string>();
  for (const id of ids) {
    const path = fileTreePathForId(snapshot, id);
    if (path !== null) paths.add(path);
    if (paths.size >= limit) break;
  }
  return [...paths].sort();
}

export function captureFileTreeNavigationState(
  options: CaptureFileTreeNavigationStateOptions,
): FileTreeNavigationState {
  const focusedPath =
    options.focusedId === null
      ? null
      : fileTreePathForId(options.snapshot, options.focusedId);
  const anchor =
    options.scrollAnchor === null || options.scrollAnchor === undefined
      ? null
      : (() => {
          const path = fileTreePathForId(options.snapshot, options.scrollAnchor.id);
          return path === null
            ? null
            : {
                path,
                offsetPx: Math.max(
                  0,
                  Number.isFinite(options.scrollAnchor.offsetPx)
                    ? options.scrollAnchor.offsetPx
                    : 0,
                ),
              };
        })();

  return Object.freeze({
    version: FILE_TREE_NAVIGATION_STATE_VERSION,
    expandedPaths: Object.freeze(
      pathsForIds(
        options.snapshot,
        options.expandedIds,
        FILE_TREE_NAVIGATION_LIMITS.expandedPaths,
      ),
    ),
    selectedPaths: Object.freeze(
      pathsForIds(
        options.snapshot,
        options.selectedIds,
        FILE_TREE_NAVIGATION_LIMITS.selectedPaths,
      ),
    ),
    focusedPath,
    filter: options.filter.slice(0, FILE_TREE_NAVIGATION_LIMITS.filterLength),
    searchMode: options.searchMode,
    scrollAnchor: anchor === null ? null : Object.freeze(anchor),
  });
}

