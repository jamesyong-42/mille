// Phase 5.4 — host command contribution contract.
//
// Hosts and extensions contribute commands (and optional menu placement
// metadata) without replacing the registry. Dispatch can be wrapped with
// progress, cancellation, failure notification, and telemetry.

import type {
  Command,
  CommandContext,
  CommandDisposable,
  CommandRegistry,
  HostHooks,
} from './types.js';
import { evaluateWhen } from './when.js';

// ─── Lifecycle / telemetry ────────────────────────────────────────────

export type CommandProgressPhase =
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CommandProgressEvent {
  readonly commandId: string;
  readonly phase: CommandProgressPhase;
  readonly message?: string;
  readonly fraction?: number;
  readonly args?: unknown;
}

export type CommandTelemetryEvent =
  | {
      readonly type: 'command.start';
      readonly commandId: string;
      readonly args?: unknown;
    }
  | {
      readonly type: 'command.success';
      readonly commandId: string;
      readonly durationMs: number;
    }
  | {
      readonly type: 'command.failure';
      readonly commandId: string;
      readonly durationMs: number;
      readonly error: unknown;
    }
  | {
      readonly type: 'command.cancel';
      readonly commandId: string;
      readonly durationMs: number;
    };

/**
 * Host lifecycle hooks for async command execution.
 */
export interface CommandLifecycleHooks {
  onProgress?(event: CommandProgressEvent): void;
  onNotify?(
    level: 'info' | 'warning' | 'error',
    message: string,
    detail?: unknown,
  ): void;
  telemetry?(event: CommandTelemetryEvent): void;
}

// ─── Contribution packages ───────────────────────────────────────────

/**
 * Menu placement for a contributed command. When omitted, the command's
 * own `group` / `when` / `visibleInContextMenu` fields apply.
 */
export interface CommandMenuContribution {
  readonly command: string;
  /** Override group (e.g. `5_scm`, `9_custom`). */
  readonly group?: string;
  /** Optional submenu bucket within the group (e.g. `history`). */
  readonly submenu?: string;
  /** Human label for the submenu when this is the first item. */
  readonly submenuLabel?: string;
  /** Sort order within the group (lower first). */
  readonly order?: number;
  readonly when?: string | ((ctx: CommandContext) => boolean);
  readonly visibleInContextMenu?: boolean | ((ctx: CommandContext) => boolean);
}

/**
 * A host or extension contribution: a named set of commands plus optional
 * menu placement overrides.
 */
export interface CommandContribution {
  /** Stable contribution id for telemetry (e.g. `host.scm`). */
  readonly id: string;
  readonly commands: readonly Command[];
  readonly menus?: {
    readonly context?: readonly CommandMenuContribution[];
  };
}

export interface ContributeCommandsResult extends CommandDisposable {
  readonly contributionId: string;
  readonly commandIds: readonly string[];
}

/**
 * Register all commands from a contribution. Disposing restores prior
 * commands for the same ids (shadow stack).
 */
export function contributeCommands(
  registry: CommandRegistry,
  contribution: CommandContribution,
): ContributeCommandsResult {
  const disposables: CommandDisposable[] = [];
  const commandIds: string[] = [];
  for (const command of contribution.commands) {
    disposables.push(registry.register(command));
    commandIds.push(command.id);
  }
  // Apply menu placement overrides onto a thin wrapper command when needed.
  if (contribution.menus?.context) {
    for (const item of contribution.menus.context) {
      const base = registry.get(item.command);
      if (!base) continue;
      const wrapped: Command = {
        ...base,
        ...(item.group !== undefined ? { group: item.group } : {}),
        ...(item.submenu !== undefined ? { submenu: item.submenu } : {}),
        ...(item.submenuLabel !== undefined
          ? { submenuLabel: item.submenuLabel }
          : {}),
        ...(item.order !== undefined ? { order: item.order } : {}),
        ...(item.when !== undefined ? { when: item.when } : {}),
        ...(item.visibleInContextMenu !== undefined
          ? { visibleInContextMenu: item.visibleInContextMenu }
          : {}),
      };
      // Only re-register when placement actually differs.
      if (
        wrapped.group !== base.group ||
        wrapped.submenu !== base.submenu ||
        wrapped.order !== base.order ||
        wrapped.when !== base.when ||
        wrapped.visibleInContextMenu !== base.visibleInContextMenu ||
        wrapped.submenuLabel !== base.submenuLabel
      ) {
        disposables.push(registry.register(wrapped));
      }
    }
  }
  return {
    contributionId: contribution.id,
    commandIds,
    dispose() {
      // Dispose in reverse so shadow stack unwinds cleanly.
      for (let i = disposables.length - 1; i >= 0; i -= 1) {
        disposables[i]?.dispose();
      }
    },
  };
}

// ─── Enablement ───────────────────────────────────────────────────────

/**
 * Whether a visible command is currently enabled. Defaults to `true`.
 * Disabled commands may still appear greyed in menus.
 */
export function evaluateEnablement(
  command: Command,
  ctx: CommandContext,
): boolean {
  const e = command.enablement;
  if (e === undefined) return true;
  if (typeof e === 'function') return Boolean(e(ctx));
  return evaluateWhen(e, ctx);
}

// ─── Dispatch with lifecycle ──────────────────────────────────────────

export interface DispatchWithLifecycleOptions {
  readonly args?: unknown;
  readonly signal?: AbortSignal;
  readonly lifecycle?: CommandLifecycleHooks;
  /**
   * When true (default), await promise-returning commands. When false,
   * fire-and-forget (still reports failure via lifecycle if the promise
   * rejects).
   */
  readonly awaitResult?: boolean;
}

/**
 * Dispatch a command with progress, cancellation, failure notification,
 * and telemetry. Augments the context with `signal` and `reportProgress`
 * for long-running host commands.
 */
export async function dispatchWithLifecycle(
  registry: CommandRegistry,
  commandId: string,
  options: DispatchWithLifecycleOptions = {},
): Promise<void> {
  const command = registry.get(commandId);
  if (!command) {
    throw new Error(`dispatchWithLifecycle: unknown command "${commandId}"`);
  }

  const lifecycle = options.lifecycle;
  const started = Date.now();
  const signal = options.signal;

  lifecycle?.telemetry?.({
    type: 'command.start',
    commandId,
    args: options.args,
  });
  lifecycle?.onProgress?.({
    commandId,
    phase: 'preparing',
    args: options.args,
  });

  // Capture the registry's context provider by dispatching through a
  // temporary wrap: we need the context. Use a side channel via host.
  // Concrete registries expose setContextProvider only; re-run provider
  // by calling dispatch with a shim is messy. Instead, require that
  // callers use the registry's dispatch when no lifecycle is needed,
  // and for lifecycle we install a one-shot provider wrap.

  // Use structural access: registries created by createCommandRegistry
  // keep contextProvider private. We re-dispatch by temporarily
  // intercepting run — simpler path: get context via a known API.
  //
  // Phase 5.4: CommandRegistry gains `getContext()` optional; for
  // backwards compat we call dispatch after patching args with lifecycle
  // on the host object.

  const reportProgress = (
    partial: Omit<CommandProgressEvent, 'commandId'>,
  ): void => {
    lifecycle?.onProgress?.({ ...partial, commandId });
  };

  try {
    if (signal?.aborted) {
      lifecycle?.telemetry?.({
        type: 'command.cancel',
        commandId,
        durationMs: Date.now() - started,
      });
      lifecycle?.onProgress?.({ commandId, phase: 'cancelled' });
      return;
    }

    lifecycle?.onProgress?.({
      commandId,
      phase: 'running',
      fraction: 0,
      args: options.args,
    });

    const stash = lifecycleStash.get(registry);
    const prev = stash?.current;
    lifecycleStash.set(registry, {
      current: {
        ...(signal !== undefined ? { signal } : {}),
        reportProgress,
        ...(lifecycle !== undefined ? { lifecycle } : {}),
      },
    });

    try {
      const result = registry.dispatch(commandId, options.args);
      if (options.awaitResult === false) {
        if (isPromise(result)) {
          void result.then(
            () => {
              lifecycle?.telemetry?.({
                type: 'command.success',
                commandId,
                durationMs: Date.now() - started,
              });
              lifecycle?.onProgress?.({
                commandId,
                phase: 'completed',
                fraction: 1,
              });
            },
            (error: unknown) => {
              lifecycle?.telemetry?.({
                type: 'command.failure',
                commandId,
                durationMs: Date.now() - started,
                error,
              });
              lifecycle?.onProgress?.({
                commandId,
                phase: 'failed',
                message: error instanceof Error ? error.message : String(error),
              });
              lifecycle?.onNotify?.(
                'error',
                error instanceof Error ? error.message : String(error),
                error,
              );
            },
          );
        } else {
          lifecycle?.telemetry?.({
            type: 'command.success',
            commandId,
            durationMs: Date.now() - started,
          });
          lifecycle?.onProgress?.({
            commandId,
            phase: 'completed',
            fraction: 1,
          });
        }
        return;
      }

      await result;
      if (signal?.aborted) {
        lifecycle?.telemetry?.({
          type: 'command.cancel',
          commandId,
          durationMs: Date.now() - started,
        });
        lifecycle?.onProgress?.({ commandId, phase: 'cancelled' });
        return;
      }
      lifecycle?.telemetry?.({
        type: 'command.success',
        commandId,
        durationMs: Date.now() - started,
      });
      lifecycle?.onProgress?.({
        commandId,
        phase: 'completed',
        fraction: 1,
      });
    } finally {
      if (prev) lifecycleStash.set(registry, { current: prev });
      else lifecycleStash.delete(registry);
    }
  } catch (error) {
    if (signal?.aborted || isCanceledError(error)) {
      lifecycle?.telemetry?.({
        type: 'command.cancel',
        commandId,
        durationMs: Date.now() - started,
      });
      lifecycle?.onProgress?.({ commandId, phase: 'cancelled' });
      return;
    }
    lifecycle?.telemetry?.({
      type: 'command.failure',
      commandId,
      durationMs: Date.now() - started,
      error,
    });
    lifecycle?.onProgress?.({
      commandId,
      phase: 'failed',
      message: error instanceof Error ? error.message : String(error),
    });
    lifecycle?.onNotify?.(
      'error',
      error instanceof Error ? error.message : String(error),
      error,
    );
    throw error;
  }
}

interface LifecycleStashEntry {
  signal?: AbortSignal;
  reportProgress?: (partial: Omit<CommandProgressEvent, 'commandId'>) => void;
  lifecycle?: CommandLifecycleHooks;
}

const lifecycleStash = new WeakMap<
  CommandRegistry,
  { current: LifecycleStashEntry }
>();

/**
 * Read the active lifecycle injection for a registry (used when building
 * CommandContext so run() can access signal / reportProgress).
 */
export function getActiveCommandLifecycle(
  registry: CommandRegistry,
): LifecycleStashEntry | null {
  return lifecycleStash.get(registry)?.current ?? null;
}

// ─── Extended context builder ─────────────────────────────────────────

/**
 * Optional IDE surfaces hosts may attach so `when` clauses and commands
 * can branch on editor / SCM / diagnostics state.
 */
export interface CommandContributionContext {
  readonly workspaceRoot?: string;
  readonly editor?: {
    readonly activePath?: string | null;
    readonly openPaths?: readonly string[];
    readonly dirtyPaths?: readonly string[];
  };
  readonly scm?: {
    readonly changedPaths?: readonly string[];
  };
  readonly diagnostics?: {
    readonly problemPaths?: readonly string[];
  };
  readonly signal?: AbortSignal;
  reportProgress?(partial: Omit<CommandProgressEvent, 'commandId'>): void;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/**
 * Merge base CommandContext fields with contribution surfaces.
 * Pure helper for hosts building setContextProvider.
 */
export function buildCommandContext(
  base: Omit<CommandContext, 'host'> & { host?: HostHooks },
  contribution?: CommandContributionContext,
): CommandContext {
  const host = base.host ?? {};
  return {
    ...base,
    host,
    ...(contribution?.workspaceRoot !== undefined
      ? { workspaceRoot: contribution.workspaceRoot }
      : {}),
    ...(contribution?.editor !== undefined
      ? { editor: contribution.editor }
      : {}),
    ...(contribution?.scm !== undefined ? { scm: contribution.scm } : {}),
    ...(contribution?.diagnostics !== undefined
      ? { diagnostics: contribution.diagnostics }
      : {}),
    ...(contribution?.signal !== undefined
      ? { signal: contribution.signal }
      : {}),
    ...(contribution?.reportProgress !== undefined
      ? { reportProgress: contribution.reportProgress }
      : {}),
    ...(contribution?.extensions !== undefined
      ? { extensions: contribution.extensions }
      : {}),
  } as CommandContext;
}

// ─── Menu model helpers ───────────────────────────────────────────────

export interface CommandMenuSubmenu {
  readonly id: string;
  readonly label: string;
  readonly items: readonly Command[];
}

export interface CommandMenuGroup {
  readonly key: string;
  readonly items: readonly Command[];
  readonly submenus: readonly CommandMenuSubmenu[];
}

/**
 * Partition visible commands into groups and nested submenus.
 * Commands with `submenu` nest under that id within their group.
 */
export function partitionCommandsForMenu(
  commands: readonly Command[],
): readonly CommandMenuGroup[] {
  type Bucket = {
    items: Command[];
    submenus: Map<string, { label: string; items: Command[] }>;
  };
  const buckets = new Map<string, Bucket>();

  const sorted = [...commands].sort((a, b) => {
    const ao = a.order ?? 0;
    const bo = b.order ?? 0;
    if (ao !== bo) return ao - bo;
    return a.id.localeCompare(b.id);
  });

  for (const c of sorted) {
    const key = c.group ?? '9_custom';
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { items: [], submenus: new Map() };
      buckets.set(key, bucket);
    }
    if (c.submenu) {
      const sid = c.submenu;
      let sub = bucket.submenus.get(sid);
      if (!sub) {
        sub = {
          label: c.submenuLabel ?? sid,
          items: [],
        };
        bucket.submenus.set(sid, sub);
      } else if (c.submenuLabel && sub.label === sid) {
        sub.label = c.submenuLabel;
      }
      sub.items.push(c);
    } else {
      bucket.items.push(c);
    }
  }

  const keys = Array.from(buckets.keys()).sort((a, b) => a.localeCompare(b));
  const out: CommandMenuGroup[] = [];
  for (const k of keys) {
    const bucket = buckets.get(k);
    if (!bucket) continue;
    const submenus: CommandMenuSubmenu[] = [];
    for (const [id, sub] of bucket.submenus) {
      if (sub.items.length > 0) {
        submenus.push({ id, label: sub.label, items: sub.items });
      }
    }
    submenus.sort((a, b) => a.id.localeCompare(b.id));
    if (bucket.items.length > 0 || submenus.length > 0) {
      out.push({ key: k, items: bucket.items, submenus });
    }
  }
  return out;
}

function isPromise<T>(v: unknown): v is Promise<T> {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}

function isCanceledError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ECANCELED' || code === 'ABORT_ERR') return true;
  }
  if (error instanceof Error && /cancel/i.test(error.message)) return true;
  return false;
}
