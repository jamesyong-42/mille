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

  /** Optional icon id (resolved by the host-configured icon resolver). */
  readonly icon?: string;

  /**
   * Run the command. `args` is command-specific; see each default command's
   * documentation for its shape. Promise returns are awaited by the dispatcher.
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
  onOpen?(entry: Entry): void;
  /** Reveal the entry in the host's editor (focus, but don't open). */
  onRevealInEditor?(entry: Entry): void;
  /** Open a terminal rooted at the given absolute path. */
  openTerminal?(path: string): void;
  /** Ask the user to confirm an action. Returning `false` aborts. */
  confirm?(message: string): boolean | Promise<boolean>;
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
   * Phase 7 — ids currently marked as "cut" in the in-app clipboard.
   * Disjoint from `copyIds`. Read by `file.paste`; drives the
   * `[data-mille-cut="true"]` row visual.
   */
  readonly cutIds: ReadonlySet<EntryId>;
  /** Phase 7 — ids currently marked as "copy". Disjoint from `cutIds`. */
  readonly copyIds: ReadonlySet<EntryId>;
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
   * Dispatch a command by id. Resolves synchronously if `run` returned
   * `void`; awaits if it returned a Promise. Throws if no command with
   * that id is registered, or if no context provider has been installed.
   */
  dispatch(id: string, args?: unknown): void | Promise<void>;

  /** All registered commands in registration order (after id overrides). */
  all(): readonly Command[];

  /**
   * Key/event → command lookup. The string overload tests against the
   * parsed form of the keybinding string; the `KeyboardEvent` overload
   * tests modifier + key against each command's `keybinding` entries.
   */
  getBinding(key: string): Command | undefined;
  getBinding(event: KeyboardEvent): Command | undefined;

  /**
   * Install the function used to materialize a `CommandContext` at dispatch
   * time. Called by the Provider once on mount. Replaces any prior provider.
   */
  setContextProvider(provider: () => CommandContext): void;
}
