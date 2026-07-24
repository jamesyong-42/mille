// CommandRegistry implementation.
//
// Pure TypeScript, no React, no engine calls. The registry is an opaque
// object returned from `createCommandRegistry`; consumers (typically the
// Provider) install a `setContextProvider` so `dispatch` can materialize
// the current UI context on demand.
//
// Override semantics: `register(cmd)` shadows any prior command with the
// same id; the returned disposable, when disposed, restores the previous
// command if one existed.

import type {
  Command,
  CommandDisposable,
  CommandContext,
  CommandRegistry,
  CommandRegistryOptions,
} from './types.js';
import {
  matchKeybinding,
  parseKeybinding,
  type KeyboardEventLike,
  type ParsedKeybinding,
} from './keybinding.js';
import { getActiveCommandLifecycle } from './contribution.js';

interface Entry {
  readonly command: Command;
  /** Stack of shadowed commands (LIFO). When the top is disposed, the next restores. */
  readonly shadow: Command[];
}

/**
 * Construct a registry from an initial command list. Later commands override
 * earlier ones (same id). A subsequent `register` further shadows whatever
 * is currently at that id.
 */
export function createCommandRegistry(
  commands: readonly Command[] = [],
  _options?: CommandRegistryOptions,
): CommandRegistry {
  const entries = new Map<string, Entry>();
  let contextProvider: (() => CommandContext) | null = null;

  // Cache for parsed keybindings per command id. Invalidated on register.
  const parsedCache = new Map<string, readonly ParsedKeybinding[]>();

  for (const c of commands) {
    install(c);
  }

  function install(command: Command): void {
    const existing = entries.get(command.id);
    if (existing) {
      existing.shadow.push(existing.command);
      entries.set(command.id, {
        command,
        shadow: existing.shadow,
      });
    } else {
      entries.set(command.id, { command, shadow: [] });
    }
    parsedCache.delete(command.id);
  }

  function getParsed(command: Command): readonly ParsedKeybinding[] {
    const cached = parsedCache.get(command.id);
    if (cached) return cached;
    const kb = command.keybinding;
    const list: ParsedKeybinding[] = [];
    if (typeof kb === 'string') {
      list.push(parseKeybinding(kb));
    } else if (Array.isArray(kb)) {
      for (const s of kb) list.push(parseKeybinding(s));
    }
    parsedCache.set(command.id, list);
    return list;
  }

  const registry: CommandRegistry = {
    get(id) {
      return entries.get(id)?.command;
    },

    register(command): CommandDisposable {
      install(command);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          const cur = entries.get(command.id);
          if (!cur) return;
          if (cur.command !== command) {
            // Something else was registered on top; remove this one from shadow.
            const idx = cur.shadow.lastIndexOf(command);
            if (idx >= 0) cur.shadow.splice(idx, 1);
            return;
          }
          const prev = cur.shadow.pop();
          if (prev) {
            entries.set(command.id, { command: prev, shadow: cur.shadow });
          } else {
            entries.delete(command.id);
          }
          parsedCache.delete(command.id);
        },
      };
    },

    dispatch(id, args) {
      const entry = entries.get(id);
      if (!entry) {
        throw new Error(`CommandRegistry.dispatch: unknown command "${id}"`);
      }
      if (!contextProvider) {
        throw new Error(
          `CommandRegistry.dispatch: no context provider installed — call setContextProvider() first`,
        );
      }
      const ctx = contextProvider();
      return entry.command.run(ctx, args);
    },

    all() {
      const out: Command[] = [];
      for (const entry of entries.values()) out.push(entry.command);
      return out;
    },

    getBinding(keyOrEvent: string | KeyboardEvent | KeyboardEventLike): Command | undefined {
      if (typeof keyOrEvent === 'string') {
        const parsed = parseKeybinding(keyOrEvent);
        for (const entry of entries.values()) {
          const bindings = getParsed(entry.command);
          for (const b of bindings) {
            if (
              b.cmd === parsed.cmd &&
              b.ctrl === parsed.ctrl &&
              b.alt === parsed.alt &&
              b.shift === parsed.shift &&
              b.key === parsed.key
            ) {
              return entry.command;
            }
          }
        }
        return undefined;
      }
      const ev = keyOrEvent;
      for (const entry of entries.values()) {
        const bindings = getParsed(entry.command);
        for (const b of bindings) {
          if (matchKeybinding(ev, b)) return entry.command;
        }
      }
      return undefined;
    },

    setContextProvider(provider) {
      // Wrap so dispatchWithLifecycle can inject signal / reportProgress
      // without hosts rewriting their provider.
      contextProvider = () => {
        const ctx = provider();
        const life = getActiveCommandLifecycle(registry);
        if (!life) return ctx;
        return {
          ...ctx,
          ...(life.signal !== undefined ? { signal: life.signal } : {}),
          ...(life.reportProgress !== undefined
            ? { reportProgress: life.reportProgress }
            : {}),
        };
      };
    },
  };

  return registry;
}
