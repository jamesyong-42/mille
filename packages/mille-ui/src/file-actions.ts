import type { Entry, EntryId } from '@vibecook/mille';

const MAX_FILE_ACTION_DEPTH = 4_096;

export interface FileActionSnapshot {
  getById(id: EntryId): Entry | null;
}

export interface FileActionTarget {
  readonly entry: Entry;
  readonly rootId: EntryId;
  readonly rootName: string;
  /** Root-qualified POSIX path; stable across duplicate relative paths. */
  readonly rootQualifiedPath: string;
  /** POSIX path below the owning root. Empty when the root itself is targeted. */
  readonly rootRelativePath: string;
}

/**
 * Materialize one bounded parent chain for host-level path actions.
 * Returns `null` for missing parents, cycles, invalid segments, or hostile depth.
 */
export function fileActionTargetForId(
  snapshot: FileActionSnapshot,
  id: EntryId,
): FileActionTarget | null {
  const targetEntry = snapshot.getById(id);
  if (targetEntry === null) return null;
  const segments: string[] = [];
  let root: Entry | null = null;
  let cursor: EntryId | null = id;
  while (cursor !== null && segments.length < MAX_FILE_ACTION_DEPTH) {
    const entry = snapshot.getById(cursor);
    if (
      entry === null ||
      entry.name.length === 0 ||
      entry.name.includes('/') ||
      entry.name.includes('\\')
    ) {
      return null;
    }
    segments.push(entry.name);
    if (entry.parentId === null) root = entry;
    cursor = entry.parentId;
  }
  if (cursor !== null || root === null || segments.length === 0) return null;

  segments.reverse();
  return Object.freeze({
    entry: targetEntry,
    rootId: root.id,
    rootName: root.name,
    rootQualifiedPath: segments.join('/'),
    rootRelativePath: segments.slice(1).join('/'),
  });
}
