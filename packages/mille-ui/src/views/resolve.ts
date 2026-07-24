// Phase 5.2 — resolve ExplorerViewSeed paths to EntryIds.

import type { Entry, EntryId, FileExplorer, Uri } from '@vibecook/mille';
import type { PortFileExplorer } from '@vibecook/mille/port';

import {
  isSafeWorkspaceRelativePath,
  mapPool,
} from '../diagnostics/provider.js';
import type {
  ExplorerViewDefinition,
  ExplorerViewItem,
  ExplorerViewModel,
  ExplorerViewSeed,
} from './types.js';
import { basenamePath } from './types.js';

export interface ViewResolverLike {
  getByUri?(uri: Uri): Promise<Entry | null> | Entry | null;
  resolvePath?(
    path: string,
  ): Promise<EntryId | number | null> | EntryId | number | null;
  getSnapshot?(): {
    getById(id: EntryId): Entry | null;
  };
}

export interface ResolveExplorerViewOptions {
  readonly fx: FileExplorer | PortFileExplorer | ViewResolverLike;
  readonly rootPath: string;
  readonly definition: ExplorerViewDefinition;
  readonly uriScheme?: string;
  /** Default 16. */
  readonly resolveConcurrency?: number;
  /**
   * When true (default), drop seeds whose path fails safety validation.
   * Unsafe paths never reach the engine.
   */
  readonly skipUnsafe?: boolean;
}

/**
 * Resolve a view definition's seeds against the engine / port client.
 * Unresolved paths remain in the model with `id: null` and are also
 * listed in `unresolvedPaths` for host diagnostics.
 */
export async function resolveExplorerView(
  options: ResolveExplorerViewOptions,
): Promise<ExplorerViewModel> {
  const {
    fx,
    rootPath,
    definition,
    uriScheme = 'file',
    resolveConcurrency = 16,
    skipUnsafe = true,
  } = options;

  const seeds = definition.seeds.filter((s) => {
    if (!skipUnsafe) return true;
    return isSafeWorkspaceRelativePath(s.path);
  });

  const resolved = await mapPool(
    seeds,
    resolveConcurrency,
    async (seed) => resolveSeed(fx, rootPath, uriScheme, seed),
  );

  const items: ExplorerViewItem[] = [];
  const unresolvedPaths: string[] = [];
  for (const item of resolved) {
    items.push(item);
    if (item.id === null) unresolvedPaths.push(item.path);
  }

  return {
    kind: definition.kind,
    title: definition.title,
    items,
    unresolvedPaths,
  };
}

async function resolveSeed(
  fx: ViewResolverLike,
  rootPath: string,
  uriScheme: string,
  seed: ExplorerViewSeed,
): Promise<ExplorerViewItem> {
  const name = seed.title ?? basenamePath(seed.path);
  const base: ExplorerViewItem = {
    id: null,
    path: seed.path,
    name,
    reason: seed.reason,
    order: seed.order ?? 0,
    ...(seed.badge !== undefined ? { badge: seed.badge } : {}),
    ...(seed.color !== undefined ? { color: seed.color } : {}),
    ...(seed.tooltip !== undefined ? { tooltip: seed.tooltip } : {}),
  };

  if (!isSafeWorkspaceRelativePath(seed.path)) {
    return base;
  }

  const entry = await resolvePathToEntry(fx, rootPath, uriScheme, seed.path);
  if (entry === null) return base;
  return {
    ...base,
    id: entry.id,
    name: entry.name.length > 0 ? entry.name : name,
  };
}

async function resolvePathToEntry(
  fx: ViewResolverLike,
  rootPath: string,
  uriScheme: string,
  workspaceRelative: string,
): Promise<Entry | null> {
  const trimmedRoot = rootPath.replace(/\/+$/, '');
  const abs = `${trimmedRoot}/${workspaceRelative}`;

  if (typeof fx.getByUri === 'function') {
    try {
      const uri: Uri = { scheme: uriScheme, path: abs };
      const maybe = fx.getByUri(uri);
      const entry = isPromise(maybe) ? await maybe : maybe;
      if (entry != null) return entry;
    } catch {
      /* fall through */
    }
  }

  if (typeof fx.resolvePath === 'function') {
    try {
      const maybe = fx.resolvePath(abs);
      const id = isPromise(maybe) ? await maybe : maybe;
      if (id == null) return null;
      if (typeof fx.getSnapshot === 'function') {
        return fx.getSnapshot().getById(id as EntryId);
      }
      // Port without snapshot walk — synthesize a minimal entry.
      return {
        id: id as EntryId,
        parentId: null,
        name: basenamePath(workspaceRelative),
        kind: 0,
        size: 0,
        mtimeMs: 0,
        ctimeMs: 0,
        isIgnored: false,
        isReadonly: false,
        isHidden: false,
      };
    } catch {
      return null;
    }
  }

  return null;
}

function isPromise<T>(v: unknown): v is Promise<T> {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}
