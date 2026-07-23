import type { EntryId } from '@vibecook/mille';
import {
  fileActionTargetForId,
  type FileActionSnapshot,
  type FileActionTarget,
} from './file-actions.js';

const MAX_FILE_SEARCH_TARGETS = 1_024;

export type FileSearchRequestKind = 'findInFolder' | 'include' | 'exclude';

/**
 * Provider-neutral search scope. The host translates root-aware literal paths
 * into ripgrep, IDE-search, remote-provider, or platform-specific syntax.
 */
export interface FileSearchRequest {
  readonly kind: FileSearchRequestKind;
  readonly targets: readonly FileActionTarget[];
}

/**
 * Materialize a bounded, de-duplicated search request atomically.
 *
 * A missing/hostile identity rejects the complete request instead of silently
 * broadening its scope. Input order is retained for predictable host UI.
 */
export function fileSearchRequestForIds(
  snapshot: FileActionSnapshot,
  kind: FileSearchRequestKind,
  ids: readonly EntryId[],
): FileSearchRequest | null {
  if (ids.length === 0 || ids.length > MAX_FILE_SEARCH_TARGETS) return null;
  const seen = new Set<EntryId>();
  const targets: FileActionTarget[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const target = fileActionTargetForId(snapshot, id);
    if (target === null) return null;
    targets.push(target);
  }
  if (targets.length === 0) return null;
  return Object.freeze({
    kind,
    targets: Object.freeze(targets),
  });
}
