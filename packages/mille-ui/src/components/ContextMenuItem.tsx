// ContextMenuItem — one entry in the <FileContextMenu>.
//
// Split out of `FileContextMenu.tsx` so slot-style overrides can import
// and recompose it. Exports both a styled default and the raw pieces
// hosts can use to build their own rendition. See MILLE_UI_SPEC.md §4.6
// and §9.3.

import { type ReactElement } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { Command, CommandContext } from '../commands/types.js';
import type { CommandRegistry } from '../commands/types.js';
import {
  formatKeybinding,
  parseKeybinding,
} from '../commands/keybinding.js';

export interface ContextMenuItemProps {
  /** The command this item dispatches. */
  readonly command: Command;
  /** The live command context (used for `label(ctx)` evaluation). */
  readonly context: CommandContext;
  /** The registry this item dispatches through. */
  readonly registry: CommandRegistry;
  /** Close the parent menu after invoke. */
  readonly onClose: () => void;
}

function resolveLabel(command: Command, context: CommandContext): string {
  return typeof command.label === 'function'
    ? command.label(context)
    : command.label;
}

function resolveShortcut(command: Command): string | null {
  const kb = command.keybinding;
  if (!kb) return null;
  const first = Array.isArray(kb) ? kb[0] : kb;
  if (typeof first !== 'string') return null;
  try {
    return formatKeybinding(parseKeybinding(first));
  } catch {
    // Invalid binding — surface nothing rather than crashing the menu.
    return null;
  }
}

export function ContextMenuItem(props: ContextMenuItemProps): ReactElement {
  const { command, context, registry, onClose } = props;
  const label = resolveLabel(command, context);
  const shortcut = resolveShortcut(command);

  return (
    <ContextMenu.Item
      className="mille-context-menu-item"
      data-mille-command-id={command.id}
      onSelect={(event: Event) => {
        // Radix fires onSelect before it would close; closing ourselves
        // lets hosts observe the registry dispatch first.
        try {
          const result = registry.dispatch(command.id);
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch(() => {
              /* swallow — individual commands own their error paths */
            });
          }
        } catch {
          /* swallow — dispatch throws only for unknown commands */
        }
        // Allow Radix to run its default close behavior.
        void event;
        onClose();
      }}
    >
      <span className="mille-context-menu-item-label">{label}</span>
      {shortcut !== null ? (
        <span className="mille-context-menu-item-shortcut">{shortcut}</span>
      ) : null}
    </ContextMenu.Item>
  );
}
ContextMenuItem.displayName = 'ContextMenuItem';
