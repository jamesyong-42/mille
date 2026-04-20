// FileContextMenu — Radix <ContextMenu.Content> populated from the
// command registry.
//
// Phase 6. MILLE_UI_SPEC.md §4.6, §9.3.
//
// This component renders ONLY the content (portal + content + items).
// The trigger wraps each row — see `FileTreeRow.tsx`. Rendering the
// content centrally means a single Radix instance handles the full
// menu population regardless of which row was right-clicked, which
// keeps the per-row Radix instance cheap (trigger-only).
//
// The component reads the command registry + live context from the
// `FileTreeContext`. It filters commands by `visibleInContextMenu` and
// `when`, groups them by `command.group` tag (alphabetical), inserts
// separators between groups, and delegates each row to
// `<ContextMenuItem>`.

import { type ReactElement, type ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { Command, CommandContext, CommandRegistry } from '../commands/types.js';
import { evaluateWhen } from '../commands/when.js';
import { ContextMenuItem } from './ContextMenuItem.js';

export interface FileContextMenuProps {
  /**
   * Registry to pull commands from. Usually the one supplied to the
   * Provider. Kept as a required prop so this component stays
   * hook-free and renderable from tests that build a registry by hand.
   */
  readonly registry: CommandRegistry;
  /**
   * Live context used for `when`/`visibleInContextMenu` predicate
   * evaluation and for resolving function-form `label`s.
   */
  readonly context: CommandContext;
  /**
   * Called after a command item is invoked (so the parent can manage
   * open state, focus restoration, etc.).
   */
  readonly onClose?: () => void;
  /** Optional consumer-supplied items appended after the built-in groups. */
  readonly extraItems?: ReactNode;
  /**
   * Shown when no command matches the current `when` context. Defaults
   * to a muted "No actions available" label so the menu never renders
   * empty.
   */
  readonly emptyPlaceholder?: ReactNode;
  /**
   * Testing/hostability hook: if provided, render the menu content
   * into this container instead of `document.body`. Radix forwards the
   * `container` prop through `ContextMenu.Portal`.
   */
  readonly portalContainer?: HTMLElement | null;
}

/** Default empty-state — deliberately minimal; hosts override. */
const DEFAULT_EMPTY: ReactNode = (
  <div
    className="mille-context-menu-empty"
    data-mille-context-menu-empty=""
    role="presentation"
  >
    No actions available
  </div>
);

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
): ReadonlyArray<{ readonly group: string; readonly items: readonly Command[] }> {
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
  const out: { group: string; items: readonly Command[] }[] = [];
  for (const k of keys) {
    const list = buckets.get(k);
    if (list && list.length > 0) out.push({ group: k, items: list });
  }
  return out;
}

/**
 * Render-only component. Wrap a Radix <ContextMenu.Root> + Trigger
 * around the row; place <FileContextMenu> once per tree (conventionally
 * as a sibling of the scroller) so it participates in the same Root
 * that Radix created for the active trigger.
 *
 * NOTE: Radix requires this to be rendered inside a `<ContextMenu.Root>`.
 * `FileTreeRow` takes care of wrapping each row in its own Root.
 */
export function FileContextMenu(props: FileContextMenuProps): ReactElement {
  const {
    registry,
    context,
    onClose,
    extraItems,
    emptyPlaceholder = DEFAULT_EMPTY,
    portalContainer,
  } = props;

  const all = registry.all();
  const visible: Command[] = [];
  for (const c of all) {
    if (!isVisibleInContextMenu(c, context)) continue;
    if (!evaluateWhen(c.when, context)) continue;
    visible.push(c);
  }

  const groups = partitionByGroup(visible);
  const isEmpty = visible.length === 0 && !extraItems;

  const close = onClose ?? (() => undefined);

  return (
    <ContextMenu.Portal
      {...(portalContainer ? { container: portalContainer } : null)}
    >
      <ContextMenu.Content
        className="mille-context-menu-content"
        data-mille-context-menu=""
        // Radix sets `role="menu"` on this element by default.
      >
        {isEmpty ? (
          emptyPlaceholder
        ) : (
          <>
            {groups.map((group, groupIdx) => (
              <ContextMenu.Group
                key={group.group}
                className="mille-context-menu-group"
                data-mille-context-menu-group={group.group}
              >
                {groupIdx > 0 ? (
                  <ContextMenu.Separator
                    className="mille-context-menu-separator"
                    data-mille-context-menu-separator=""
                  />
                ) : null}
                {group.items.map((command) => (
                  <ContextMenuItem
                    key={command.id}
                    command={command}
                    context={context}
                    registry={registry}
                    onClose={close}
                  />
                ))}
              </ContextMenu.Group>
            ))}
            {extraItems !== undefined && extraItems !== null ? (
              <>
                {groups.length > 0 ? (
                  <ContextMenu.Separator
                    className="mille-context-menu-separator"
                    data-mille-context-menu-separator="extra"
                  />
                ) : null}
                {extraItems}
              </>
            ) : null}
          </>
        )}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}
FileContextMenu.displayName = 'FileContextMenu';
