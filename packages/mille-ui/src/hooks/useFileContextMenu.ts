// useFileContextMenu — logic hook behind `<FileContextMenu>`.
//
// Phase B8 of V0_2_PLAN.md. Pulls the `visibleInContextMenu` +
// `when`-predicate filtering and the group-by-tag partition out of the
// Radix-facing component so the `/headless` entry can expose menu
// composition without pulling in Radix.
//
// The hook is Radix-free: it produces a sorted list of groups, each
// holding commands, plus a `onItemSelect(commandId)` callback that
// resolves the current command and invokes it with the live menu context
// while swallowing the throw/rejection
// paths. Consumers can render into Radix, ARIA-only menus, a palette,
// or anything else.

import { useCallback, useMemo } from 'react';
import type { Command, CommandContext, CommandRegistry } from '../commands/types.js';
import { evaluateWhen } from '../commands/when.js';
import {
  evaluateEnablement,
  partitionCommandsForMenu,
  type CommandMenuGroup,
  type CommandMenuSubmenu,
} from '../commands/contribution.js';

export interface UseFileContextMenuOptions {
  readonly registry: CommandRegistry;
  readonly context: CommandContext;
  /** Called after a command item is invoked (close menu, restore focus). */
  readonly onClose?: () => void;
}

/** One visual group of commands — partitioned by `command.group` tag. */
export interface UseFileContextMenuGroup {
  /** The raw group key (e.g. `'1_navigation'` or `'9_custom'`). */
  readonly key: string;
  readonly items: readonly Command[];
  /** Phase 5.4 — nested submenus within this group. */
  readonly submenus?: readonly CommandMenuSubmenu[];
}

export interface UseFileContextMenuResult {
  /**
   * All visible commands, flattened. Use when you don't care about
   * group partitioning (e.g. a command-palette-style listing).
   */
  readonly items: readonly Command[];
  /** Visible commands partitioned by group tag, sorted alphabetically. */
  readonly groups: readonly UseFileContextMenuGroup[];
  /** `true` when no command matched the current `when` context. */
  readonly isEmpty: boolean;
  /** Whether a visible command is currently enabled. */
  readonly isEnabled: (command: Command) => boolean;
  /** Invoke a command by id with the live context; swallows errors. */
  readonly onItemSelect: (commandId: string) => void;
  /** Invoke when the menu visually closes — runs the caller's `onClose`. */
  readonly onClose: () => void;
}

/**
 * Visible-in-context-menu filter. Default is `true` when unset — matches
 * the `Command` type docstring. Function form is evaluated with the
 * current context.
 */
function isVisibleInContextMenu(command: Command, ctx: CommandContext): boolean {
  const v = command.visibleInContextMenu;
  if (v === undefined) return true;
  if (typeof v === 'function') return Boolean(v(ctx));
  return Boolean(v);
}

export function useFileContextMenu(
  options: UseFileContextMenuOptions,
): UseFileContextMenuResult {
  const { registry, context, onClose } = options;

  const items = useMemo<readonly Command[]>(() => {
    const all = registry.all();
    const visible: Command[] = [];
    for (const c of all) {
      if (!isVisibleInContextMenu(c, context)) continue;
      if (!evaluateWhen(c.when, context)) continue;
      visible.push(c);
    }
    return visible;
  }, [registry, context]);

  const groups = useMemo<readonly UseFileContextMenuGroup[]>(() => {
    const partitioned: readonly CommandMenuGroup[] =
      partitionCommandsForMenu(items);
    return partitioned.map((g) => ({
      key: g.key,
      items: g.items,
      ...(g.submenus.length > 0 ? { submenus: g.submenus } : {}),
    }));
  }, [items]);

  const isEnabled = useCallback(
    (command: Command) => evaluateEnablement(command, context),
    [context],
  );

  const close = useCallback(() => {
    if (onClose) onClose();
  }, [onClose]);

  const onItemSelect = useCallback(
    (commandId: string) => {
      try {
        const command = registry.get(commandId);
        if (!command) {
          close();
          return;
        }
        if (!evaluateEnablement(command, context)) {
          close();
          return;
        }
        // Live menu context is authoritative for selection/enablement.
        // Prefer dispatchWithContext so enablement is re-checked at invoke.
        const result =
          typeof registry.dispatchWithContext === 'function'
            ? registry.dispatchWithContext(commandId, context)
            : command.run(context);
        if (result && typeof (result as Promise<void>).then === 'function') {
          void (result as Promise<void>).then(undefined, (error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            try {
              context.host?.notify?.('error', message, error);
            } catch {
              /* ignore */
            }
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        try {
          context.host?.notify?.('error', message, error);
        } catch {
          /* ignore */
        }
      }
      close();
    },
    [registry, context, close],
  );

  return {
    items,
    groups,
    isEmpty: items.length === 0,
    isEnabled,
    onItemSelect,
    onClose: close,
  };
}
