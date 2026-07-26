// Listener bookkeeping shared by every channel implementation.
//
// Small on purpose. It exists so the CH-005/CH-007/CH-008 semantics are
// written once instead of re-derived per transport: disposal is
// idempotent, emitting snapshots the set first so a listener that
// subscribes or unsubscribes during dispatch cannot corrupt the walk, and
// a throwing listener is reported rather than allowed to abort the
// remaining ones.

import type { Disposable } from '../types.js';
import type { ExplorerChannelLogger } from './types.js';

export const NOOP_LOGGER: ExplorerChannelLogger = {
  warn: () => {
    /* silent by default — embedders opt in */
  },
};

export class ListenerSet<T> {
  readonly #listeners = new Set<(value: T) => void>();
  readonly #logger: ExplorerChannelLogger;
  readonly #label: string;

  constructor(label: string, logger: ExplorerChannelLogger = NOOP_LOGGER) {
    this.#label = label;
    this.#logger = logger;
  }

  get size(): number {
    return this.#listeners.size;
  }

  add(listener: (value: T) => void): Disposable {
    this.#listeners.add(listener);
    let disposed = false;
    return {
      dispose: () => {
        // CH-007: disposing twice is not an error, and must not remove a
        // listener that was re-added under the same function reference.
        if (disposed) return;
        disposed = true;
        this.#listeners.delete(listener);
      },
    };
  }

  /**
   * CH-008: channel code must not swallow listener exceptions silently,
   * but a bad listener must not take the channel down either. Report and
   * carry on to the next one.
   */
  emit(value: T): void {
    if (this.#listeners.size === 0) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(value);
      } catch (err) {
        this.#logger.warn(`${this.#label} listener threw`, err);
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
