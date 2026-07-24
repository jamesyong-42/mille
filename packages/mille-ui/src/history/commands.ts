// Phase 5.3 — default SCM / history commands for the command registry.
//
// Hosts inject ScmClient + FileHistoryClient + ScmActionHooks via a
// small binder object attached to HostHooks-style context extensions.
// Commands degrade with EUNSUPPORTED when clients are missing.
//
// Destructive actions group by owning workspace root so multi-root
// selections never collapse `rootA/same.ts` and `rootB/same.ts`.

import type { EntryId } from '@vibecook/mille';
import { fileActionTargetForId } from '../file-actions.js';
import type { Command, CommandContext, HostHooks } from '../commands/types.js';
import { runFileHistory, runScmCompare, runScmRevert } from './actions.js';
import type {
  FileHistoryClient,
  FileHistoryRevision,
  ScmActionHooks,
  ScmClient,
  ScmCompareResult,
} from './types.js';

/**
 * Extended host surface for SCM/history. Stored on `ctx.host`, so it is a
 * `HostHooks` first: hosts that annotate their hooks object as `ScmHostHooks`
 * keep access to the base surface (`notify`, `confirm`, `refresh`, …) instead
 * of having those members rejected as excess properties.
 */
export interface ScmHostHooks extends HostHooks, ScmActionHooks {
  readonly scm?: ScmClient;
  readonly history?: FileHistoryClient;
  /**
   * Map an engine root entry to an absolute filesystem root for SCM.
   * Required for correct multi-root revert/compare when `workspaceRoot`
   * alone is ambiguous.
   */
  resolveRootPath?(rootId: EntryId, rootName: string): string | undefined;
  /**
   * Present compare result (or open host diff UI). Required for a useful
   * compare command when the client returns content rather than opening UI.
   */
  onCompareResult?(result: ScmCompareResult): void | Promise<void>;
  /**
   * Present file history revisions (timeline panel).
   */
  onHistoryResult?(
    path: string,
    revisions: readonly FileHistoryRevision[],
  ): void | Promise<void>;
}

/** One SCM target with stable root identity. */
export interface ScmPathTarget {
  readonly rootId: EntryId;
  readonly rootName: string;
  readonly rootRelativePath: string;
  /** Absolute workspace root when resolved. */
  readonly rootPath?: string;
}

function scmHost(ctx: CommandContext): ScmHostHooks {
  return ctx.host as ScmHostHooks;
}

function resolveAbsoluteRoot(
  ctx: CommandContext,
  rootId: EntryId,
  rootName: string,
): string | undefined {
  const host = scmHost(ctx);
  const fromHost = host.resolveRootPath?.(rootId, rootName);
  if (typeof fromHost === 'string' && fromHost.length > 0) return fromHost;
  if (typeof ctx.workspaceRoot === 'string' && ctx.workspaceRoot.length > 0) {
    return ctx.workspaceRoot;
  }
  return undefined;
}

/**
 * Build root-qualified SCM targets for the current selection (or focus).
 * Dedupes by `(rootId, rootRelativePath)` — never by relative path alone.
 */
export function selectedScmTargets(ctx: CommandContext): ScmPathTarget[] {
  const out: ScmPathTarget[] = [];
  const seen = new Set<string>();
  const ids =
    ctx.selectedIds.size > 0
      ? [...ctx.selectedIds]
      : ctx.focusedId !== null
        ? [ctx.focusedId]
        : [];
  for (const id of ids) {
    const target = fileActionTargetForId(ctx.snapshot, id);
    if (target === null) continue;
    const key = `${String(target.rootId)}\0${target.rootRelativePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rootPath = resolveAbsoluteRoot(ctx, target.rootId, target.rootName);
    out.push({
      rootId: target.rootId,
      rootName: target.rootName,
      rootRelativePath: target.rootRelativePath,
      ...(rootPath !== undefined ? { rootPath } : {}),
    });
  }
  return out;
}

export function focusedScmTarget(ctx: CommandContext): ScmPathTarget | null {
  if (ctx.focusedId === null) return null;
  const target = fileActionTargetForId(ctx.snapshot, ctx.focusedId);
  if (target === null) return null;
  const rootPath = resolveAbsoluteRoot(ctx, target.rootId, target.rootName);
  return {
    rootId: target.rootId,
    rootName: target.rootName,
    rootRelativePath: target.rootRelativePath,
    ...(rootPath !== undefined ? { rootPath } : {}),
  };
}

/**
 * Group targets by absolute root for per-root SCM mutations.
 * Targets without a resolvable rootPath are skipped.
 */
export function groupScmTargetsByRoot(
  targets: readonly ScmPathTarget[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const t of targets) {
    if (t.rootPath === undefined || t.rootPath.length === 0) continue;
    if (t.rootRelativePath.length === 0) continue;
    const list = groups.get(t.rootPath) ?? [];
    list.push(t.rootRelativePath);
    groups.set(t.rootPath, list);
  }
  return groups;
}

/**
 * Default SCM/history commands. Register alongside `defaultCommands` or
 * merge into a host registry.
 */
export const scmHistoryCommands: readonly Command[] = Object.freeze([
  {
    id: 'scm.compareWithHead',
    label: 'Compare with HEAD',
    group: '5_scm',
    submenu: 'compare',
    submenuLabel: 'Compare',
    order: 10,
    when: 'focusedIs.file',
    async run(ctx) {
      const target = focusedScmTarget(ctx);
      if (target === null || target.rootRelativePath.length === 0) return;
      const host = scmHost(ctx);
      if (!host.scm) return;
      const result = await runScmCompare(
        {
          path: target.rootRelativePath,
          ...(target.rootPath !== undefined
            ? { rootPath: target.rootPath }
            : {}),
          left: { kind: 'revision', revision: 'HEAD' },
          right: { kind: 'working' },
        },
        {
          client: host.scm,
          hooks: host,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        },
      );
      if (result !== undefined && result !== null) {
        await host.onCompareResult?.(result);
      }
    },
  },
  {
    id: 'scm.compareWithPrevious',
    label: 'Compare with Previous Revision',
    group: '5_scm',
    submenu: 'compare',
    submenuLabel: 'Compare',
    order: 20,
    when: 'focusedIs.file',
    async run(ctx) {
      const target = focusedScmTarget(ctx);
      if (target === null || target.rootRelativePath.length === 0) return;
      const host = scmHost(ctx);
      if (!host.scm || !host.history) return;
      const revs = await runFileHistory(
        host.history,
        {
          path: target.rootRelativePath,
          limit: 2,
          ...(target.rootPath !== undefined
            ? { rootPath: target.rootPath }
            : {}),
        },
        {
          hooks: host,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        },
      );
      const previous = revs[1] ?? revs[0];
      if (previous === undefined) return;
      const result = await runScmCompare(
        {
          path: target.rootRelativePath,
          ...(target.rootPath !== undefined
            ? { rootPath: target.rootPath }
            : {}),
          left: { kind: 'revision', revision: previous.id },
          right: { kind: 'working' },
        },
        {
          client: host.scm,
          hooks: host,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        },
      );
      if (result !== undefined && result !== null) {
        await host.onCompareResult?.(result);
      }
    },
  },
  {
    id: 'scm.showHistory',
    label: 'Show File History',
    group: '5_scm',
    when: 'focusedIs.file',
    async run(ctx) {
      const target = focusedScmTarget(ctx);
      if (target === null || target.rootRelativePath.length === 0) return;
      const host = scmHost(ctx);
      if (!host.history) return;
      const revisions = await runFileHistory(
        host.history,
        {
          path: target.rootRelativePath,
          limit: 50,
          ...(target.rootPath !== undefined
            ? { rootPath: target.rootPath }
            : {}),
        },
        {
          hooks: host,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        },
      );
      await host.onHistoryResult?.(target.rootRelativePath, revisions);
    },
  },
  {
    id: 'scm.revert',
    label: (ctx) =>
      ctx.isMultiSelect
        ? 'Discard Changes in Selection…'
        : 'Discard Changes…',
    group: '5_scm',
    when: 'hasSelection || focusedIs.file',
    async run(ctx) {
      const targets = selectedScmTargets(ctx);
      if (targets.length === 0) return;
      const host = scmHost(ctx);
      if (!host.scm) return;
      const groups = groupScmTargetsByRoot(targets);
      if (groups.size === 0) {
        // Fall back: relative paths only when every target lacks rootPath
        // (single-root hosts that omit workspaceRoot still work if the
        // SCM client defaults its root).
        const paths = targets
          .map((t) => t.rootRelativePath)
          .filter((p) => p.length > 0);
        if (paths.length === 0) return;
        await runScmRevert(paths, {
          client: host.scm,
          hooks: host,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        return;
      }
      for (const [rootPath, paths] of groups) {
        await runScmRevert(paths, {
          client: host.scm,
          hooks: host,
          rootPath,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
      }
    },
  },
] as const satisfies readonly Command[]);
