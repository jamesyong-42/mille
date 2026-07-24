// Provider registry — scheme dispatch for non-file filesystems.
//
// Override stack is a true LIFO shadow: disposing a non-top registration
// only removes that entry from the shadow; it never resurrects a disposed
// provider over a still-active one.

import { FileSystemError } from '../errors.js';
import type { Disposable, FileSystemProvider, Uri } from './types.js';

export interface ProviderRegistration {
  readonly scheme: string;
  readonly capabilities: number;
}

export interface ProviderRegistry {
  register(provider: FileSystemProvider): Disposable;
  get(scheme: string): FileSystemProvider | undefined;
  list(): readonly ProviderRegistration[];
  /**
   * Resolve a provider for `uri.scheme`. Throws FileSystemError(EUNSUPPORTED)
   * when no provider is registered.
   */
  resolve(uri: Uri): FileSystemProvider;
}

interface SchemeSlot {
  /** Active (top) provider. */
  current: FileSystemProvider;
  /**
   * Shadow stack of previously registered providers (older → newer).
   * Pop restores the most recent non-disposed predecessor.
   */
  shadow: FileSystemProvider[];
}

export function createProviderRegistry(
  initial: readonly FileSystemProvider[] = [],
): ProviderRegistry {
  const byScheme = new Map<string, SchemeSlot>();

  for (const p of initial) {
    byScheme.set(p.scheme, { current: p, shadow: [] });
  }

  return {
    register(provider) {
      const scheme = provider.scheme;
      if (scheme.length === 0) {
        throw new TypeError('provider.scheme must be non-empty');
      }
      const existing = byScheme.get(scheme);
      if (existing) {
        existing.shadow.push(existing.current);
        existing.current = provider;
      } else {
        byScheme.set(scheme, { current: provider, shadow: [] });
      }
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          const slot = byScheme.get(scheme);
          if (!slot) return;

          if (slot.current === provider) {
            const prev = slot.shadow.pop();
            if (prev) {
              slot.current = prev;
            } else {
              byScheme.delete(scheme);
            }
            return;
          }

          // Mid-stack dispose: remove this registration from the shadow only.
          const idx = slot.shadow.lastIndexOf(provider);
          if (idx >= 0) slot.shadow.splice(idx, 1);
        },
      };
    },

    get(scheme) {
      return byScheme.get(scheme)?.current;
    },

    list() {
      const out: ProviderRegistration[] = [];
      for (const [scheme, slot] of byScheme) {
        out.push({ scheme, capabilities: slot.current.capabilities });
      }
      return out;
    },

    resolve(uri) {
      const p = byScheme.get(uri.scheme)?.current;
      if (!p) {
        throw new FileSystemError(
          'EUNSUPPORTED',
          `No filesystem provider registered for scheme "${uri.scheme}"`,
          uri.path,
        );
      }
      return p;
    },
  };
}
