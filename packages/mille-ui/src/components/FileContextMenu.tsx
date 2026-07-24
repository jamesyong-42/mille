// FileContextMenu — Radix <ContextMenu.Content> populated from the
// command registry.
//
// Phase B8 (v0.2): thin view on top of `useFileContextMenu`. All
// filtering, sorting, grouping, and dispatch logic lives in the hook;
// this component owns nothing but the Radix portal / content / group /
// separator plumbing.
//
// MILLE_UI_SPEC.md §4.6, §9.3.
//
// The component reads the command registry + live context, delegates
// filtering to the hook, renders Radix groups with separators between
// them, and defers each row to `<ContextMenuItem>`.

import { type ReactElement, type ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { CommandContext, CommandRegistry } from '../commands/types.js';
import { useFileContextMenu } from '../hooks/useFileContextMenu.js';
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

  const optionArgs: Parameters<typeof useFileContextMenu>[0] = onClose
    ? { registry, context, onClose }
    : { registry, context };
  const { groups, onClose: close } = useFileContextMenu(optionArgs);

  const isEmpty = groups.length === 0 && !extraItems;

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
                key={group.key}
                className="mille-context-menu-group"
                data-mille-context-menu-group={group.key}
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
                {group.submenus?.map((sub) => (
                  <ContextMenu.Sub key={sub.id}>
                    <ContextMenu.SubTrigger
                      className="mille-context-menu-item mille-context-menu-subtrigger"
                      data-mille-submenu={sub.id}
                    >
                      <span className="mille-context-menu-item-label">
                        {sub.label}
                      </span>
                    </ContextMenu.SubTrigger>
                    <ContextMenu.Portal>
                      <ContextMenu.SubContent
                        className="mille-context-menu-content"
                        data-mille-submenu-content={sub.id}
                      >
                        {sub.items.map((command) => (
                          <ContextMenuItem
                            key={command.id}
                            command={command}
                            context={context}
                            registry={registry}
                            onClose={close}
                          />
                        ))}
                      </ContextMenu.SubContent>
                    </ContextMenu.Portal>
                  </ContextMenu.Sub>
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
