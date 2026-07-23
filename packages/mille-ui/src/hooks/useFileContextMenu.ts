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

/**
 * Group-tag sort: alphabetical. Matches SPEC §9.3. Commands with no
 * `group` sort to an implicit `'9_custom'` bucket so host-added
 * commands-without-a-tag land at the end.
 */
function groupKey(command: Command): string {
  return command.group ?? '9_custom';
}

/** Partition the visible command list into ordered groups. */
function partitionByGroup(
  commands: readonly Command[],
): readonly UseFileContextMenuGroup[] {
  const buckets = new Map<string, Command[]>();
  for (const c of commands) {
    const key = groupKey(c);
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(c);
  }
  const keys = Array.from(buckets.keys()).sort((a, b) => a.localeCompare(b));
  const out: UseFileContextMenuGroup[] = [];
  for (const k of keys) {
    const list = buckets.get(k);
    if (list && list.length > 0) out.push({ key: k, items: list });
  }
  return out;
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

  const groups = useMemo<readonly UseFileContextMenuGroup[]>(
    () => partitionByGroup(items),
    [items],
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
        // The menu already owns the authoritative live context used for its
        // visibility checks. Invoke the currently registered command with
        // that same context instead of depending on a separate registry
        // context provider that embedded trees may not install.
        const result = command.run(context);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => {
            /* swallow — individual commands own their error paths */
          });
        }
      } catch {
        /* swallow — dispatch throws only for unknown commands */
      }
      close();
    },
    [registry, context, close],
  );

  return {
    items,
    groups,
    isEmpty: items.length === 0,
    onItemSelect,
    onClose: close,
  };
}
