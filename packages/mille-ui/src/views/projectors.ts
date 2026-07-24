// Phase 5.2 — pure view projectors from host data sources.
//
// Each projector maps decoration/client snapshots into ExplorerViewSeed[]
// without touching the engine. Resolution to EntryId is a separate step.

import type { Diagnostic, DiagnosticSeverity } from '../diagnostics/types.js';
import {
  countDiagnostics,
  maxSeverityFromCounts,
  totalDiagnosticCount,
} from '../diagnostics/types.js';
import type { EditorStateSnapshot } from '../editor-state/types.js';
import { normalizeEditorState } from '../editor-state/types.js';
import type { GitStatusEntry, GitStatusLetter } from '../git/client.js';
import type { TestResult, TestStatus } from '../test-status/types.js';
import {
  countsFromResult,
  maxStatusFromCounts,
  totalTestCount,
} from '../test-status/types.js';
import type { ExplorerViewDefinition, ExplorerViewSeed } from './types.js';
import { basenamePath, sortViewSeeds } from './types.js';

// ─── Open Files ───────────────────────────────────────────────────────

export interface ProjectOpenFilesOptions {
  /** Include only dirty tabs. Default false (all open). */
  readonly dirtyOnly?: boolean;
  /** View title. Default "Open Files". */
  readonly title?: string;
}

/**
 * Project editor tabs into an Open Files view.
 * Active first, then dirty, then path order.
 */
export function projectOpenFilesView(
  snapshot: EditorStateSnapshot,
  options: ProjectOpenFilesOptions = {},
): ExplorerViewDefinition {
  const flags = normalizeEditorState(snapshot);
  const seeds: ExplorerViewSeed[] = [];
  for (const [path, f] of flags) {
    if (options.dirtyOnly === true && !f.dirty) continue;
    let order = 100;
    if (f.active) order = 0;
    else if (f.dirty) order = 10;
    const reasons: string[] = ['open'];
    if (f.dirty) reasons.push('dirty');
    if (f.active) reasons.push('active');
    seeds.push({
      path,
      reason: reasons.join('+'),
      order,
      title: f.title ?? basenamePath(path),
      ...(f.dirty
        ? {
            badge: '●',
            color: 'var(--mille-decoration-dirty, #57606a)',
            tooltip: f.active
              ? 'Active editor · Unsaved changes'
              : 'Unsaved changes',
          }
        : f.active
          ? { tooltip: 'Active editor' }
          : { tooltip: 'Open in editor' }),
    });
  }
  return {
    kind: 'openFiles',
    title: options.title ?? 'Open Files',
    seeds: sortViewSeeds(seeds),
  };
}

// ─── Changed Files (SCM) ──────────────────────────────────────────────

export interface ProjectChangedFilesOptions {
  /** Drop ignored (`!`) entries. Default true. */
  readonly hideIgnored?: boolean;
  readonly title?: string;
}

const GIT_ORDER: Readonly<Record<GitStatusLetter, number>> = Object.freeze({
  U: 0,
  M: 10,
  A: 20,
  D: 30,
  R: 40,
  C: 50,
  '?': 60,
  '!': 70,
});

/**
 * Project a git status map into a Changed Files view.
 * Accepts either absolute-key maps (GitClient) or path-keyed maps;
 * uses each entry's workspace-relative `path` field.
 */
export function projectChangedFilesView(
  status:
    | ReadonlyMap<string, GitStatusEntry>
    | readonly GitStatusEntry[],
  options: ProjectChangedFilesOptions = {},
): ExplorerViewDefinition {
  const hideIgnored = options.hideIgnored !== false;
  const list = Array.isArray(status) ? status : [...status.values()];
  const seeds: ExplorerViewSeed[] = [];
  for (const entry of list) {
    if (hideIgnored && entry.status === '!') continue;
    const staged = entry.staged === true;
    const letter = entry.status as GitStatusLetter;
    seeds.push({
      path: entry.path,
      reason: staged ? `git:${letter}:staged` : `git:${letter}`,
      order: GIT_ORDER[letter] ?? 50,
      badge: letter,
      tooltip: staged ? `staged ${letter}` : letter,
    });
  }
  return {
    kind: 'changedFiles',
    title: options.title ?? 'Changed Files',
    seeds: sortViewSeeds(seeds),
  };
}

// ─── Problems (diagnostics) ───────────────────────────────────────────

export interface ProjectProblemsViewOptions {
  /**
   * Minimum severity to include. Default `'info'` (error+warning+info).
   * Use `'error'` for failures-only.
   */
  readonly minSeverity?: DiagnosticSeverity;
  readonly title?: string;
}

const SEV_ORDER: Readonly<Record<DiagnosticSeverity, number>> = Object.freeze({
  error: 0,
  warning: 10,
  info: 20,
  hint: 30,
});

const SEV_RANK: Readonly<Record<DiagnosticSeverity, number>> = Object.freeze({
  error: 3,
  warning: 2,
  info: 1,
  hint: 0,
});

/**
 * Project diagnostics into a Problems view — one row per path that has
 * diagnostics at or above `minSeverity`. Badge is problem count; color by
 * max severity on that path.
 */
export function projectProblemsView(
  diagnostics: ReadonlyMap<string, readonly Diagnostic[]>,
  options: ProjectProblemsViewOptions = {},
): ExplorerViewDefinition {
  const min = options.minSeverity ?? 'info';
  const minRank = SEV_RANK[min];
  const seeds: ExplorerViewSeed[] = [];

  for (const [path, diags] of diagnostics) {
    if (diags.length === 0) continue;
    const filtered = diags.filter((d) => SEV_RANK[d.severity] >= minRank);
    if (filtered.length === 0) continue;
    const counts = countDiagnostics(filtered);
    const severity = maxSeverityFromCounts(counts);
    if (severity === null) continue;
    const total = totalDiagnosticCount(counts);
    seeds.push({
      path,
      reason: `diagnostic:${severity}`,
      order: SEV_ORDER[severity],
      badge: String(total),
      color: `var(--mille-decoration-${severity}, currentColor)`,
      tooltip: formatProblemsTooltip(counts),
    });
  }

  return {
    kind: 'problems',
    title: options.title ?? 'Problems',
    seeds: sortViewSeeds(seeds),
  };
}

function formatProblemsTooltip(counts: {
  error: number;
  warning: number;
  info: number;
  hint: number;
}): string {
  const parts: string[] = [];
  if (counts.error > 0) {
    parts.push(counts.error === 1 ? '1 error' : `${counts.error} errors`);
  }
  if (counts.warning > 0) {
    parts.push(
      counts.warning === 1 ? '1 warning' : `${counts.warning} warnings`,
    );
  }
  if (counts.info > 0) {
    parts.push(counts.info === 1 ? '1 info' : `${counts.info} infos`);
  }
  if (counts.hint > 0) {
    parts.push(counts.hint === 1 ? '1 hint' : `${counts.hint} hints`);
  }
  return parts.join(', ');
}

// ─── Failed tests ─────────────────────────────────────────────────────

export interface ProjectFailedTestsViewOptions {
  /**
   * Statuses to include. Default `['failed', 'errored']`.
   */
  readonly statuses?: readonly TestStatus[];
  readonly title?: string;
}

/**
 * Project test results into a Failed Tests (or filtered tests) view.
 */
export function projectFailedTestsView(
  results: ReadonlyMap<string, TestResult> | readonly TestResult[],
  options: ProjectFailedTestsViewOptions = {},
): ExplorerViewDefinition {
  const allow = new Set(
    options.statuses ?? (['failed', 'errored'] as const),
  );
  const list = Array.isArray(results) ? results : [...results.values()];
  const seeds: ExplorerViewSeed[] = [];
  for (const result of list) {
    const counts = countsFromResult(result);
    const status = maxStatusFromCounts(counts) ?? result.status;
    if (!allow.has(status)) continue;
    const total = totalTestCount(counts);
    const badge =
      result.counts !== undefined && total > 0
        ? String(counts.failed + counts.errored || total)
        : status === 'failed'
          ? '✗'
          : status === 'errored'
            ? '!'
            : status === 'running'
              ? '…'
              : status === 'skipped'
                ? '○'
                : '✓';
    seeds.push({
      path: result.path,
      reason: `test:${status}`,
      order: status === 'failed' ? 0 : status === 'errored' ? 5 : 20,
      badge,
      color: `var(--mille-decoration-test-${status}, currentColor)`,
      tooltip: result.message ?? `Test ${status}`,
    });
  }
  return {
    kind: 'failedTests',
    title: options.title ?? 'Failed Tests',
    seeds: sortViewSeeds(seeds),
  };
}

// ─── Custom scope ─────────────────────────────────────────────────────

/**
 * Host-defined saved scope from an explicit path list.
 */
export function projectCustomScopeView(
  paths: readonly string[],
  options: { title?: string; reason?: string } = {},
): ExplorerViewDefinition {
  const reason = options.reason ?? 'custom';
  const seeds: ExplorerViewSeed[] = paths.map((path, i) => ({
    path,
    reason,
    order: i,
    title: basenamePath(path),
  }));
  return {
    kind: 'custom',
    title: options.title ?? 'Scope',
    seeds: sortViewSeeds(seeds),
  };
}
