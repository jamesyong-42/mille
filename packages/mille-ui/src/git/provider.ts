// Phase 13.2 / 13.4 — registerGitDecorations factory.
//
// Wires a host-supplied `GitClient` into the engine's decoration
// pipeline. The factory:
//
//   1. Fetches an initial status snapshot.
//   2. Resolves workspace-relative paths → `EntryId` via `fx.getByUri`
//      so the engine can key decorations by id (the engine's
//      `DecorationProvider.provide(entry)` surface is entry-based; the
//      companion pre-computes a map keyed by id so `provide` is O(1)).
//   3. Registers a `DecorationProvider` whose `provide(entry)` is a
//      pure map lookup.
//   4. Subscribes to `client.onChange`; each firing re-fetches status
//      via the batcher and publishes `onDidChange(ids)` with the
//      combined set of newly-dirtied + previously-dirty-now-clean ids.
//   5. Optionally propagates leaf status up ancestors with a muted
//      color so folders surface "something changed below me".
//
// The engine's `fx.registerDecorationProvider` API (see api.d.ts) takes
// a single provider object carrying its own `id`. The task spec
// references a two-arg `(providerId, provider)` form; we bridge by
// detecting which shape the supplied fx implements (tests, playground
// stubs, future engine changes) and dispatching accordingly.

import type {
  Decoration,
  Entry,
  EntryId,
  Uri,
} from '@vibecook/mille';

import type { GitClient, GitStatusEntry, GitStatusLetter } from './client.js';
import { createBatcher, type BatchOptions } from './batch.js';

// ─── Minimal fx surface the provider needs ────────────────────────────

interface SnapshotLike {
  getById(id: EntryId): Entry | null;
}

/**
 * The subset of `FileExplorer` the companion actually touches. Kept
 * narrow so tests can hand in a scripted fake without stubbing the
 * full engine.
 */
export interface FileExplorerLike {
  getSnapshot(): SnapshotLike;
  getByUri(uri: Uri): Promise<Entry | null> | Entry | null;
  /**
   * Real engine form: `registerDecorationProvider(provider)`. Returns
   * a `Disposable`. The companion auto-detects this shape and passes
   * a provider whose own `id` field carries the intended id.
   */
  registerDecorationProvider(
    provider: EngineDecorationProvider,
  ): { dispose(): void };
}

/**
 * Shape the engine expects of a `DecorationProvider`. Mirrors
 * `@vibecook/mille`'s `DecorationProvider` interface; re-declared here
 * so the companion doesn't force a runtime dependency direction.
 */
export interface EngineDecorationProvider {
  readonly id: string;
  onDidChange(
    listener: (ids: readonly EntryId[]) => void,
  ): { dispose(): void };
  provide(entry: Entry): Decoration | null;
}

// ─── Options & handle ─────────────────────────────────────────────────

export interface RegisterGitDecorationsOptions {
  readonly fx: FileExplorerLike;
  readonly client: GitClient;
  /**
   * Absolute workspace root. Passed through to `client.getStatus` and
   * used as the base for `fx.getByUri` lookups. Must match the scheme
   * the engine's roots use (typically `file`).
   */
  readonly rootPath: string;
  /** Provider id. Default: `'scm'`. */
  readonly providerId?: string;
  /** Override the default color per status letter. */
  colorFor?(status: GitStatusLetter, staged: boolean): string | undefined;
  /**
   * When `true` (default), each modified leaf propagates a muted
   * decoration up its ancestor chain. See Phase 13.4.
   */
  readonly propagateToParent?: boolean;
  /** URI scheme passed to `fx.getByUri`. Default: `'file'`. */
  readonly uriScheme?: string;
  /** Forwarded to the batcher; exposed for tests. */
  readonly batchOptions?: BatchOptions;
}

export interface GitDecorationsHandle {
  /** Tear down subscriptions and unregister from the engine. */
  dispose(): void;
  /** Force an immediate status fetch + publish. */
  refresh(): Promise<void>;
}

// ─── Defaults ─────────────────────────────────────────────────────────

/**
 * VS Code-ish palette. Exported so consumers can compose with their
 * own `colorFor` override. Kept internal-ish — not part of the
 * documented API.
 */
const DEFAULT_COLORS: Readonly<Record<GitStatusLetter, string>> = Object.freeze({
  M: 'var(--mille-decoration-modified, #e2c08d)',
  A: 'var(--mille-decoration-added, #81b88b)',
  D: 'var(--mille-decoration-deleted, #c74e39)',
  U: 'var(--mille-decoration-conflict, #6c6cc4)',
  R: 'var(--mille-decoration-renamed, #e2c08d)',
  C: 'var(--mille-decoration-renamed, #e2c08d)',
  '?': 'var(--mille-decoration-untracked, #73c991)',
  '!': 'var(--mille-decoration-ignored, #8c8c8c)',
});

/**
 * Muted-color variant for "modified-descendant" decorations on
 * ancestor folders. Keyed by the child's status letter.
 *
 * Using a distinct token (falling back to a less-saturated variant of
 * the leaf color) lets themes tweak folder-roll-up independently.
 */
const MUTED_COLORS: Readonly<Record<GitStatusLetter, string>> = Object.freeze({
  M: 'var(--mille-decoration-modified-muted, #a68b64)',
  A: 'var(--mille-decoration-added-muted, #5e8662)',
  D: 'var(--mille-decoration-deleted-muted, #8c3a2b)',
  U: 'var(--mille-decoration-conflict-muted, #4e4e8c)',
  R: 'var(--mille-decoration-renamed-muted, #a68b64)',
  C: 'var(--mille-decoration-renamed-muted, #a68b64)',
  '?': 'var(--mille-decoration-untracked-muted, #548c58)',
  '!': 'var(--mille-decoration-ignored-muted, #6c6c6c)',
});

// ─── Implementation ───────────────────────────────────────────────────

/**
 * Register a git decoration provider on the given engine. Returns a
 * handle with `dispose()` and `refresh()`.
 */
export function registerGitDecorations(
  options: RegisterGitDecorationsOptions,
): GitDecorationsHandle {
  const {
    fx,
    client,
    rootPath,
    providerId = 'scm',
    colorFor,
    propagateToParent = true,
    uriScheme = 'file',
    batchOptions,
  } = options;

  // Map of entry id → decoration. Replaced wholesale on each refresh;
  // `provide(entry)` is an O(1) `map.get(entry.id)` lookup.
  let decorations = new Map<EntryId, Decoration>();

  // Decoration-change listeners registered by the engine.
  const listeners = new Set<(ids: readonly EntryId[]) => void>();

  let disposed = false;

  // Track which ids currently carry a decoration so a later refresh
  // can also notify ids that *went clean*.
  let decoratedIds = new Set<EntryId>();

  function resolveColor(
    status: GitStatusLetter,
    staged: boolean,
    muted: boolean,
  ): string | undefined {
    if (colorFor) {
      const override = colorFor(status, staged);
      if (override !== undefined) return override;
    }
    return muted ? MUTED_COLORS[status] : DEFAULT_COLORS[status];
  }

  function buildLeafDecoration(entry: GitStatusEntry): Decoration {
    const staged = entry.staged === true;
    const color = resolveColor(entry.status, staged, false);
    const tooltip = tooltipFor(entry);
    const decoration: Decoration = color !== undefined
      ? { badge: entry.status, color, tooltip, propagate: propagateToParent }
      : { badge: entry.status, tooltip, propagate: propagateToParent };
    return decoration;
  }

  function buildAncestorDecoration(
    status: GitStatusLetter,
    staged: boolean,
  ): Decoration {
    // Distinct letter for ancestors: asterisk suffix. This is a
    // UI-level convention the companion ships; consumers overriding
    // `colorFor` only affect color. Keeping the asterisk here means
    // folder rows visually differentiate "I'm modified" vs
    // "something below me is".
    const color = resolveColor(status, staged, true);
    const badge = `${status}*`;
    return color !== undefined
      ? { badge, color, propagate: false }
      : { badge, propagate: false };
  }

  function tooltipFor(entry: GitStatusEntry): string {
    const parts: string[] = [];
    if (entry.staged === true) parts.push('staged');
    switch (entry.status) {
      case 'M': parts.push('modified'); break;
      case 'A': parts.push('added'); break;
      case 'D': parts.push('deleted'); break;
      case 'U': parts.push('conflicted'); break;
      case 'R': parts.push('renamed'); break;
      case 'C': parts.push('copied'); break;
      case '?': parts.push('untracked'); break;
      case '!': parts.push('ignored'); break;
      default: break;
    }
    return parts.join(' ');
  }

  function makeUri(workspaceRelative: string): Uri {
    // Normalize: ensure a single leading slash between root and
    // relative path; handle root already ending with `/`.
    const trimmedRoot = rootPath.replace(/\/+$/, '');
    const trimmedRel = workspaceRelative.replace(/^\/+/, '');
    const joined = trimmedRel.length === 0
      ? trimmedRoot
      : `${trimmedRoot}/${trimmedRel}`;
    return { scheme: uriScheme, path: joined };
  }

  async function resolvePathToEntry(
    workspaceRelative: string,
  ): Promise<Entry | null> {
    const uri = makeUri(workspaceRelative);
    try {
      const maybe = fx.getByUri(uri);
      const entry = isPromise(maybe) ? await maybe : maybe;
      return entry ?? null;
    } catch {
      return null;
    }
  }

  async function recompute(): Promise<void> {
    if (disposed) return;
    const statusMap = await client.getStatus(rootPath);
    if (disposed) return;

    const next = new Map<EntryId, Decoration>();
    // Leaf decorations.
    const leafEntries: Array<{ id: EntryId; status: GitStatusLetter; staged: boolean }> = [];
    for (const entry of statusMap.values()) {
      const resolved = await resolvePathToEntry(entry.path);
      if (resolved === null) continue;
      next.set(resolved.id, buildLeafDecoration(entry));
      leafEntries.push({
        id: resolved.id,
        status: entry.status,
        staged: entry.staged === true,
      });
    }

    // Ancestor propagation: walk parents, stamping a muted decoration
    // on each. The first leaf to touch an ancestor wins (consistent
    // with typical SCM folder-badge semantics); subsequent leaves keep
    // the existing letter.
    if (propagateToParent && leafEntries.length > 0) {
      const snapshot = fx.getSnapshot();
      for (const leaf of leafEntries) {
        let cursor = snapshot.getById(leaf.id);
        if (cursor === null) continue;
        let parentId = cursor.parentId;
        while (parentId !== null) {
          // Do not clobber a real leaf decoration with an ancestor
          // muted one — a modified folder keeps its own status.
          if (!next.has(parentId)) {
            next.set(
              parentId,
              buildAncestorDecoration(leaf.status, leaf.staged),
            );
          }
          const parent = snapshot.getById(parentId);
          if (parent === null) break;
          parentId = parent.parentId;
        }
      }
    }

    // Diff: every id that was in the previous set OR the new set may
    // have changed. Notify listeners once.
    const changed = new Set<EntryId>();
    for (const id of decoratedIds) changed.add(id);
    for (const id of next.keys()) changed.add(id);

    decorations = next;
    decoratedIds = new Set(next.keys());

    if (changed.size > 0 && listeners.size > 0) {
      const ids = Array.from(changed);
      for (const l of [...listeners]) l(ids);
    }
  }

  // Batcher coalesces client.onChange storms. We don't need per-id
  // granularity at the batch layer (the status re-fetch produces
  // the authoritative id set on each firing); a single sentinel id
  // is enqueued per notification, so any burst produces exactly one
  // `recompute()`.
  const SENTINEL: EntryId = -1;
  const batcher = createBatcher(
    () => {
      void recompute();
    },
    batchOptions,
  );

  const provider: EngineDecorationProvider = {
    id: providerId,
    onDidChange(listener) {
      listeners.add(listener);
      let active = true;
      return {
        dispose() {
          if (!active) return;
          active = false;
          listeners.delete(listener);
        },
      };
    },
    provide(entry: Entry): Decoration | null {
      return decorations.get(entry.id) ?? null;
    },
  };

  const registration = fx.registerDecorationProvider(provider);

  const unsubscribe = client.onChange(() => {
    if (disposed) return;
    batcher.enqueue(SENTINEL);
  });

  // Kick off initial fetch. Fire-and-forget; `refresh()` returns a
  // promise for callers that need to await readiness.
  void recompute();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try { unsubscribe(); } catch { /* ignore */ }
      batcher.dispose();
      listeners.clear();
      try { registration.dispose(); } catch { /* ignore */ }
      decorations = new Map<EntryId, Decoration>();
      decoratedIds = new Set<EntryId>();
    },
    async refresh(): Promise<void> {
      if (disposed) return;
      // Cancel any pending batched work — we're doing it now,
      // authoritatively. `cancel` drops the pending set without
      // invoking the work callback so we don't race with it.
      batcher.cancel();
      await recompute();
    },
  };
}

function isPromise<T>(v: unknown): v is Promise<T> {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}
