// Phase 5.3 — default SCM / history commands for the command registry.
//
// Hosts inject ScmClient + FileHistoryClient + ScmActionHooks via a
// small binder object attached to HostHooks-style context extensions.
// Commands degrade with EUNSUPPORTED when clients are missing.

import { fileActionTargetForId } from '../file-actions.js';
import type { Command, CommandContext } from '../commands/types.js';
import { runFileHistory, runScmCompare, runScmRevert } from './actions.js';
import type {
  FileHistoryClient,
  FileHistoryRevision,
  ScmActionHooks,
  ScmClient,
  ScmCompareResult,
} from './types.js';

/**
 * Extended host surface for SCM/history. Stored on `ctx.host` via
 * structural typing (extra fields are allowed on HostHooks objects).
 */
export interface ScmHostHooks extends ScmActionHooks {
  readonly scm?: ScmClient;
  readonly history?: FileHistoryClient;
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

function scmHost(ctx: CommandContext): ScmHostHooks {
  return ctx.host as ScmHostHooks;
}

function focusedRelativePath(ctx: CommandContext): string | null {
  if (ctx.focusedId === null) return null;
  const target = fileActionTargetForId(ctx.snapshot, ctx.focusedId);
  return target?.rootRelativePath ?? null;
}

function selectedRelativePaths(ctx: CommandContext): string[] {
  const paths: string[] = [];
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
    if (seen.has(target.rootRelativePath)) continue;
    seen.add(target.rootRelativePath);
    paths.push(target.rootRelativePath);
  }
  return paths;
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
    when: 'focusedIs.file',
    async run(ctx) {
      const path = focusedRelativePath(ctx);
      if (path === null) return;
      const host = scmHost(ctx);
      if (!host.scm) return;
      const result = await runScmCompare(
        {
          path,
          left: { kind: 'revision', revision: 'HEAD' },
          right: { kind: 'working' },
        },
        { client: host.scm, hooks: host },
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
    when: 'focusedIs.file',
    async run(ctx) {
      const path = focusedRelativePath(ctx);
      if (path === null) return;
      const host = scmHost(ctx);
      if (!host.scm || !host.history) return;
      const revs = await runFileHistory(
        host.history,
        { path, limit: 2 },
        { hooks: host },
      );
      const previous = revs[1] ?? revs[0];
      if (previous === undefined) return;
      const result = await runScmCompare(
        {
          path,
          left: { kind: 'revision', revision: previous.id },
          right: { kind: 'working' },
        },
        { client: host.scm, hooks: host },
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
      const path = focusedRelativePath(ctx);
      if (path === null) return;
      const host = scmHost(ctx);
      if (!host.history) return;
      const revisions = await runFileHistory(
        host.history,
        { path, limit: 50 },
        { hooks: host },
      );
      await host.onHistoryResult?.(path, revisions);
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
      const paths = selectedRelativePaths(ctx);
      if (paths.length === 0) return;
      const host = scmHost(ctx);
      if (!host.scm) return;
      await runScmRevert(paths, {
        client: host.scm,
        hooks: host,
      });
    },
  },
] as const satisfies readonly Command[]);
