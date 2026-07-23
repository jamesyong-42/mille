import type { Entry, EntryId } from '@vibecook/mille';

const MAX_ANCESTOR_DEPTH = 10_000;

export interface ExpansionSnapshot {
  getById(id: EntryId): Entry | null;
}

/**
 * Select currently-expanded descendants of one entry without materializing the
 * visible projection. Parent classifications are memoized, keeping wide and
 * deep trees linear in the expanded identities plus their distinct ancestors.
 */
export function expandedDescendantIds(
  snapshot: ExpansionSnapshot,
  expandedIds: ReadonlySet<EntryId>,
  rootId: EntryId,
  includeRoot = false,
): readonly EntryId[] {
  if (snapshot.getById(rootId) === null) return [];
  const belowRoot = new Map<EntryId, boolean>([[rootId, true]]);
  const descendants: EntryId[] = [];

  for (const candidate of expandedIds) {
    if (candidate === rootId) {
      if (includeRoot) descendants.push(candidate);
      continue;
    }
    const candidateEntry = snapshot.getById(candidate);
    if (candidateEntry === null) continue;
    if (candidateEntry.parentId === rootId) {
      descendants.push(candidate);
      continue;
    }

    const chain: EntryId[] = [];
    let seen: Set<EntryId> | null = null;
    let cursor: EntryId | null = candidate;
    let isDescendant = false;
    while (cursor !== null && chain.length < MAX_ANCESTOR_DEPTH) {
      const cached = belowRoot.get(cursor);
      if (cached !== undefined) {
        isDescendant = cached;
        break;
      }
      if (seen !== null) {
        if (seen.has(cursor)) break;
        seen.add(cursor);
      } else if (chain.length === 64) {
        seen = new Set(chain);
        if (seen.has(cursor)) break;
        seen.add(cursor);
      }
      chain.push(cursor);
      const entry = snapshot.getById(cursor);
      cursor = entry?.parentId ?? null;
    }
    for (const id of chain) belowRoot.set(id, isDescendant);
    if (isDescendant) descendants.push(candidate);
  }

  return descendants;
}
