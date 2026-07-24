// Phase 5.1 — registerEditorStateDecorations factory.
//
// Decorates open / dirty / active editor paths. Pattern mirrors the
// hardened diagnostics companion:
//   - getByUri or resolvePath path resolution
//   - generation token against stale fetches
//   - bounded concurrent resolve
//   - value-diff onDidChange
//   - background onError
//   - workspace-relative path validation
//
// Glyph policy (coexists with SCM/diagnostics when registered carefully):
//   - dirty  → badge "●", dirty color, tooltip "Unsaved changes"
//   - open   → badge "○" (muted), tooltip "Open in editor" (unless dirty)
//   - active → tooltip includes "Active editor"; badge still dirty/open glyph
//
// Merge with other providers is later-wins on overlapping fields. Prefer
// registering editor-state after SCM if dirty dots should beat git letters,
// or before diagnostics so problem counts remain on the badge slot.

import type {
  Decoration,
  Entry,
  EntryId,
  FileExplorer,
  Uri,
} from '@vibecook/mille';
import type { PortFileExplorer } from '@vibecook/mille/port';

import { createBatcher, type BatchOptions } from '../git/batch.js';
import {
  decorationEquals,
  isSafeWorkspaceRelativePath,
  mapPool,
} from '../diagnostics/provider.js';
import type {
  EditorPathFlags,
  EditorStateClient,
  EditorStateSnapshot,
} from './types.js';
import { normalizeEditorState } from './types.js';

// ─── Minimal fx surface ───────────────────────────────────────────────

interface SnapshotLike {
  getById(id: EntryId): Entry | null;
}

export interface FileExplorerLike {
  getSnapshot(): SnapshotLike;
  getByUri?(uri: Uri): Promise<Entry | null> | Entry | null;
  resolvePath?(
    path: string,
  ): Promise<EntryId | number | null> | EntryId | number | null;
  registerDecorationProvider(
    provider: EngineDecorationProvider,
  ): { dispose(): void };
}

export interface EngineDecorationProvider {
  readonly id: string;
  onDidChange(
    listener: (ids: readonly EntryId[]) => void,
  ): { dispose(): void };
  provide(entry: Entry): Decoration | null;
}

// ─── Options & handle ─────────────────────────────────────────────────

export interface RegisterEditorStateDecorationsOptions {
  readonly fx: FileExplorer | PortFileExplorer | FileExplorerLike;
  readonly client: EditorStateClient;
  readonly rootPath: string;
  /** Default: `'editor-state'`. */
  readonly providerId?: string;
  readonly uriScheme?: string;
  readonly batchOptions?: BatchOptions;
  /** Default: 16. */
  readonly resolveConcurrency?: number;
  /**
   * When false, open-but-clean tabs get no badge (only dirty/active
   * tooltips). Default true — open files show a hollow circle.
   */
  readonly decorateOpen?: boolean;
  onError?(error: unknown): void;
  /** Override dirty / open / active colors. */
  colorFor?(state: 'dirty' | 'open' | 'active'): string | undefined;
  badgeFor?(flags: EditorPathFlags): string | undefined;
  tooltipFor?(flags: EditorPathFlags): string | undefined;
  readonly registrar?: (provider: EngineDecorationProvider) => Disposable;
}

interface Disposable {
  dispose(): void;
}

export interface EditorStateDecorationsHandle {
  dispose(): void;
  refresh(): Promise<void>;
}

// ─── Defaults ─────────────────────────────────────────────────────────

export const DEFAULT_EDITOR_STATE_COLORS = Object.freeze({
  dirty: 'var(--mille-decoration-dirty, #cccccc)',
  open: 'var(--mille-decoration-open, #8b949e)',
  active: 'var(--mille-decoration-active, #58a6ff)',
});

const DEFAULT_RESOLVE_CONCURRENCY = 16;

export function formatEditorStateTooltip(flags: EditorPathFlags): string {
  const parts: string[] = [];
  if (flags.active) parts.push('Active editor');
  if (flags.dirty) parts.push('Unsaved changes');
  else if (flags.open) parts.push('Open in editor');
  return parts.join(' · ');
}

export function formatEditorStateBadge(flags: EditorPathFlags): string {
  if (flags.dirty) return '●';
  if (flags.open) return '○';
  return '';
}

// ─── Implementation ───────────────────────────────────────────────────

export function registerEditorStateDecorations(
  options: RegisterEditorStateDecorationsOptions,
): EditorStateDecorationsHandle {
  const {
    fx,
    client,
    rootPath,
    providerId = 'editor-state',
    uriScheme = 'file',
    batchOptions,
    resolveConcurrency = DEFAULT_RESOLVE_CONCURRENCY,
    decorateOpen = true,
    onError,
    colorFor,
    badgeFor,
    tooltipFor,
  } = options;

  let decorations = new Map<EntryId, Decoration>();
  const listeners = new Set<(ids: readonly EntryId[]) => void>();
  let disposed = false;
  let decoratedIds = new Set<EntryId>();
  let generation = 0;

  const reportError =
    onError ??
    ((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[mille-ui/editor-state] recompute failed:', error);
    });

  function resolveColor(flags: EditorPathFlags): string | undefined {
    if (flags.dirty) {
      const o = colorFor?.('dirty');
      return o !== undefined ? o : DEFAULT_EDITOR_STATE_COLORS.dirty;
    }
    if (flags.active) {
      const o = colorFor?.('active');
      return o !== undefined ? o : DEFAULT_EDITOR_STATE_COLORS.active;
    }
    if (flags.open) {
      const o = colorFor?.('open');
      return o !== undefined ? o : DEFAULT_EDITOR_STATE_COLORS.open;
    }
    return undefined;
  }

  function buildDecoration(flags: EditorPathFlags): Decoration | null {
    if (!flags.open && !flags.dirty && !flags.active) return null;

    let badge =
      badgeFor !== undefined
        ? badgeFor(flags)
        : formatEditorStateBadge(flags);
    if (badge === undefined) badge = formatEditorStateBadge(flags);

    // Open-clean without decorateOpen: still emit tooltip-only decoration
    // for active; skip clean open entirely when decorateOpen is false.
    if (!flags.dirty && flags.open && !flags.active && !decorateOpen) {
      return null;
    }
    if (
      !flags.dirty &&
      flags.open &&
      !decorateOpen &&
      flags.active
    ) {
      // Active-only: no hollow circle unless host wants it.
      badge = '';
    }

    const tooltip =
      tooltipFor !== undefined
        ? (tooltipFor(flags) ?? formatEditorStateTooltip(flags))
        : formatEditorStateTooltip(flags);
    const color = resolveColor(flags);

    if (
      (badge === undefined || badge.length === 0) &&
      tooltip.length === 0 &&
      color === undefined
    ) {
      return null;
    }

    return {
      ...(badge !== undefined && badge.length > 0 ? { badge } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(tooltip.length > 0 ? { tooltip } : {}),
      propagate: false,
    };
  }

  function absolutePathFor(workspaceRelative: string): string {
    const trimmedRoot = rootPath.replace(/\/+$/, '');
    return `${trimmedRoot}/${workspaceRelative}`;
  }

  function makeUri(workspaceRelative: string): Uri {
    return { scheme: uriScheme, path: absolutePathFor(workspaceRelative) };
  }

  async function resolvePathToEntry(
    workspaceRelative: string,
  ): Promise<Entry | null> {
    if (!isSafeWorkspaceRelativePath(workspaceRelative)) return null;
    const handle = fx as FileExplorerLike;

    if (typeof handle.getByUri === 'function') {
      try {
        const maybe = handle.getByUri(makeUri(workspaceRelative));
        const entry = isPromise(maybe) ? await maybe : maybe;
        if (entry != null) return entry;
      } catch {
        /* fall through */
      }
    }

    if (typeof handle.resolvePath === 'function') {
      try {
        const maybe = handle.resolvePath(absolutePathFor(workspaceRelative));
        const id = isPromise(maybe) ? await maybe : maybe;
        if (id == null) return null;
        return handle.getSnapshot().getById(id as EntryId);
      } catch {
        return null;
      }
    }
    return null;
  }

  async function recompute(): Promise<void> {
    if (disposed) return;
    const myGen = ++generation;

    let snapshot: EditorStateSnapshot;
    try {
      const raw = client.getEditorState(rootPath);
      snapshot = isPromise(raw) ? await raw : raw;
    } catch (error) {
      if (disposed || myGen !== generation) return;
      throw error;
    }
    if (disposed || myGen !== generation) return;

    const flagsByPath = normalizeEditorState(snapshot);
    const entries = [...flagsByPath.entries()].filter(([path]) =>
      isSafeWorkspaceRelativePath(path),
    );

    const resolved = await mapPool(
      entries,
      resolveConcurrency,
      async ([path, flags]) => {
        if (disposed || myGen !== generation) return null;
        const entry = await resolvePathToEntry(path);
        if (entry === null) return null;
        const decoration = buildDecoration(flags);
        if (decoration === null) return null;
        return { id: entry.id, decoration };
      },
    );

    if (disposed || myGen !== generation) return;

    const next = new Map<EntryId, Decoration>();
    for (const item of resolved) {
      if (item === null) continue;
      next.set(item.id, item.decoration);
    }

    const changed: EntryId[] = [];
    for (const id of decoratedIds) {
      if (!decorationEquals(decorations.get(id), next.get(id) ?? null)) {
        changed.push(id);
      }
    }
    for (const [id, dec] of next) {
      if (!decoratedIds.has(id) || !decorationEquals(decorations.get(id), dec)) {
        if (!changed.includes(id)) changed.push(id);
      }
    }

    decorations = next;
    decoratedIds = new Set(next.keys());

    if (changed.length > 0 && listeners.size > 0) {
      for (const l of [...listeners]) l(changed);
    }
  }

  async function recomputeBackground(): Promise<void> {
    try {
      await recompute();
    } catch (error) {
      if (disposed) return;
      try {
        reportError(error);
      } catch {
        /* ignore */
      }
    }
  }

  const SENTINEL: EntryId = -1;
  const batcher = createBatcher(
    () => {
      void recomputeBackground();
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

  const registration = options.registrar
    ? options.registrar(provider)
    : fx.registerDecorationProvider(provider);

  const unsubscribe = client.onChange(() => {
    if (disposed) return;
    batcher.enqueue(SENTINEL);
  });

  void recomputeBackground();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      batcher.dispose();
      listeners.clear();
      try {
        registration.dispose();
      } catch {
        /* ignore */
      }
      decorations = new Map();
      decoratedIds = new Set();
    },
    async refresh(): Promise<void> {
      if (disposed) return;
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
