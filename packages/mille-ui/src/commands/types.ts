// Command registry types for @vibecook/mille-ui.
//
// These types are framework-agnostic — no React imports here. The Provider
// (Phase 1+) and other UI layers are responsible for materializing a
// `CommandContext` at dispatch time via `setContextProvider` on the registry.
//
// See MILLE_UI_SPEC.md §9 for the authoritative design.

import type {
  Entry,
  EntryId,
  FileExplorer,
  MirrorSnapshot,
} from '@vibecook/mille';
import type { FileOpenEvent } from '../open-policy.js';
import type { FileActionTarget } from '../file-actions.js';
import type { FileSearchRequest } from '../file-search.js';

export type FileRefreshTarget =
  | Readonly<{ kind: 'subtree'; id: EntryId; recursive: true }>
  | Readonly<{ kind: 'workspace' }>;

/**
 * A single invocable command. Commands are the only mutation path in the
 * UI — key handlers, context-menu items, toolbar buttons all dispatch
 * commands. Host apps register overrides to wrap, replace, or extend.
 */
export interface Command {
  /** Dotted identifier, e.g. `file.rename`. Unique within a registry. */
  readonly id: string;

  /** Human-facing label; may depend on context. */
  readonly label: string | ((ctx: CommandContext) => string);

  /**
   * Keybinding string(s) in VS Code format (`Mod+Shift+F2`). `Mod` maps
   * to Cmd on macOS, Ctrl elsewhere. See `keybinding.ts` for the grammar.
   */
  readonly keybinding?: string | readonly string[];

  /**
   * Visibility predicate. String form is a whitelist mini-language evaluated
   * by `evaluateWhen` (see `when.ts`); function form is the escape hatch.
   */
  readonly when?: string | ((ctx: CommandContext) => boolean);

  /** Whether to show in context menus. Defaults to `true` if unset. */
  readonly visibleInContextMenu?: boolean | ((ctx: CommandContext) => boolean);

  /** Whether to show in menu-bar menus. Defaults to `false` if unset. */
  readonly visibleInMenuBar?: boolean;

  /** Group tag for menu grouping (`1_navigation`, `2_modification`, ...). */
  readonly group?: string;

  /**
   * Phase 5.4 — nest under a submenu within `group` (e.g. `history`).
   * Context menus render nested items; palettes may flatten with a prefix.
   */
  readonly submenu?: string;

  /** Human label for the submenu when this command is first to declare it. */
  readonly submenuLabel?: string;

  /**
   * Phase 5.4 — sort order within a group / submenu (lower first).
   * Defaults to registration order when unset.
   */
  readonly order?: number;

  /**
   * Phase 5.4 — enablement predicate. Distinct from `when` (visibility):
   * a command may be visible but disabled (greyed). String form uses the
   * same mini-language as `when`. Defaults to enabled when unset.
   */
  readonly enablement?: string | ((ctx: CommandContext) => boolean);

  /** Optional icon id (resolved by the host-configured icon resolver). */
  readonly icon?: string;

  /**
   * Run the command. `args` is command-specific; see each default command's
   * documentation for its shape. Promise returns are awaited by the dispatcher.
   * Long-running commands may use `ctx.signal` and `ctx.reportProgress`.
   */
  run(ctx: CommandContext, args?: unknown): void | Promise<void>;
}

/**
 * Host-provided escape-hatch callbacks for actions that the engine cannot
 * perform on its own — opening a file in the editor, revealing in the OS,
 * asking the user for confirmation before a destructive action. All optional.
 */
export interface HostHooks {
  /** Open the given entry in the host's editor / preview surface. */
  onOpen?(entry: Entry, event: FileOpenEvent): void;
  /** Reveal the entry in the host's editor (focus, but don't open). */
  onRevealInEditor?(entry: Entry): void;
  /** Copy an absolute or workspace-relative path through the host clipboard. */
  copyPath?(
    target: FileActionTarget,
    kind: 'absolute' | 'relative',
  ): void | Promise<void>;
  /** Reveal the target in Finder, Explorer, or the desktop file manager. */
  revealInFileManager?(target: FileActionTarget): void | Promise<void>;
  /** Open the directory itself, or a file's containing directory. */
  openContainingFolder?(target: FileActionTarget): void | Promise<void>;
  /** Open a terminal at a directory, or at a file's parent directory. */
  openTerminalForEntry?(target: FileActionTarget): void | Promise<void>;
  /** Reconcile one subtree or the complete workspace through the host. */
  refresh?(target: FileRefreshTarget): void | Promise<void>;
  /** Open or refine the host's content-search UI with exact tree scopes. */
  searchScope?(request: FileSearchRequest): void | Promise<void>;
  /**
   * Open a terminal rooted at the given absolute path.
   * @deprecated Prefer `openTerminalForEntry`; retained for host compatibility.
   */
  openTerminal?(path: string): void;
  /** Ask the user to confirm an action. Returning `false` aborts. */
  confirm?(message: string): boolean | Promise<boolean>;
  /**
   * Phase 5.4 — optional failure/progress notification surface for
   * commands that do not use `dispatchWithLifecycle` directly.
   */
  notify?(
    level: 'info' | 'warning' | 'error',
    message: string,
    detail?: unknown,
  ): void;
}

/**
 * Materialized view of the UI state at dispatch time. Registries call the
 * context provider (registered via `setContextProvider`) to build this on
 * demand. Consumers constructing ad-hoc commands can also build one by hand
 * for testing.
 */
export interface CommandContext {
  readonly fx: FileExplorer;
  readonly snapshot: MirrorSnapshot;
  readonly focusedId: EntryId | null;
  readonly focusedEntry: Entry | null;
  readonly selectedIds: ReadonlySet<EntryId>;
  readonly selectedEntries: readonly Entry[];
  readonly isMultiSelect: boolean;
  readonly isRenaming: boolean;
  readonly host: HostHooks;
  /**
   * Optional controlled expansion surface. Styled trees supply this so menu
   * commands update React state first; headless registries may omit it and
   * delegate directly to `fx.setExpanded`.
   */
  readonly expansion?: {
    readonly expandedIds: ReadonlySet<EntryId>;
    setExpanded(diff: {
      readonly add?: readonly EntryId[];
      readonly remove?: readonly EntryId[];
    }): void;
  };
  /**
   * Phase 7 — ids currently marked as "cut" in the in-app clipboard.
   * Disjoint from `copyIds`. Read by `file.paste`; drives the
   * `[data-mille-cut="true"]` row visual.
   */
  readonly cutIds: ReadonlySet<EntryId>;
  /** Phase 7 — ids currently marked as "copy". Disjoint from `cutIds`. */
  readonly copyIds: ReadonlySet<EntryId>;

  // ─── Phase 5.4 — contribution / IDE surfaces ──────────────────────
  /** Absolute workspace root when known (multi-root hosts may omit). */
  readonly workspaceRoot?: string;
  /** Active editor / open tabs summary for enablement and host commands. */
  readonly editor?: {
    readonly activePath?: string | null;
    readonly openPaths?: readonly string[];
    readonly dirtyPaths?: readonly string[];
  };
  /** SCM changed paths when a status client is available. */
  readonly scm?: {
    readonly changedPaths?: readonly string[];
  };
  /** Paths with diagnostics when a diagnostics client is available. */
  readonly diagnostics?: {
    readonly problemPaths?: readonly string[];
  };
  /** Cancellation for long-running dispatches (`dispatchWithLifecycle`). */
  readonly signal?: AbortSignal;
  /** Progress reporter injected by `dispatchWithLifecycle`. */
  reportProgress?(partial: {
    readonly phase: 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled';
    readonly message?: string;
    readonly fraction?: number;
  }): void;
  /** Host-defined extension bag for custom `when` / command logic. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/**
 * Parse-time options for `createCommandRegistry`. Reserved for future use;
 * kept as a discrete interface so consumers can spread config stably.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface CommandRegistryOptions {
  /** Reserved for future use. */
  readonly reserved?: never;
}

/**
 * Disposable handle returned by `register`. Calling `dispose()` removes the
 * command from the registry (restoring any previously-registered command
 * with the same id, if there was one).
 */
export interface CommandDisposable {
  dispose(): void;
}

/**
 * The registry interface. Concrete instances are opaque objects returned
 * from `createCommandRegistry`. Every mutation in the UI flows through
 * `dispatch`.
 */
export interface CommandRegistry {
  /** Look up a command by id. */
  get(id: string): Command | undefined;

  /**
   * Register (or replace) a command by id. If an existing command has the
   * same id, it's shadowed until `dispose()` on the returned handle is
   * called, at which point the previous command is restored.
   */
  register(command: Command): CommandDisposable;

  /**
   * Dispatch a command by id using the installed context provider.
   * Honors `enablement` (no-ops when disabled). Resolves synchronously if
   * `run` returned `void`; awaits if it returned a Promise. Throws if no
   * command with that id is registered, or if no context provider has been
   * installed.
   */
  dispatch(id: string, args?: unknown): void | Promise<void>;

  /**
   * Dispatch with an explicit context (menus that already own a live
   * selection snapshot). Honors `enablement` against that context.
   */
  dispatchWithContext(
    id: string,
    ctx: CommandContext,
    args?: unknown,
  ): void | Promise<void>;

  /**
   * Materialize the current command context via the installed provider.
   * Used by `dispatchWithLifecycle` to build a per-dispatch context with
   * signal / progress without shared mutable lifecycle state.
   */
  getContext(): CommandContext;

  /** All registered commands in registration order (after id overrides). */
  all(): readonly Command[];

  /**
   * Key/event → command lookup. The string overload tests against the
   * parsed form of the keybinding string; the `KeyboardEvent` overload
   * tests modifier + key against each command's `keybinding` entries.
   * Does not evaluate enablement — call `dispatch` / `dispatchWithContext`
   * which do.
   */
  getBinding(key: string): Command | undefined;
  getBinding(event: KeyboardEvent): Command | undefined;

  /**
   * Install the function used to materialize a `CommandContext` at dispatch
   * time. Called by the Provider once on mount. Replaces any prior provider.
   */
  setContextProvider(provider: () => CommandContext): void;
}
