// MessagePort implementation of ExplorerChannel (SPEC §10).
//
// This is the compatibility path: `attachPort()` and `connectFileExplorer()`
// build one of these, so existing in-process consumers get the new
// abstraction with byte-identical behavior and no migration.
//
// `adaptPort` used to be duplicated in host.ts and client-port.ts. It lives
// here now — one normalizer, one set of quirks to reason about.

import type { Disposable, MessagePortLike } from '../types.js';
import type { ClientToHostMessage, HostToClientMessage } from '../protocol.js';
import { ListenerSet, NOOP_LOGGER } from './emitter.js';
import type {
  ExplorerChannel,
  ExplorerChannelCloseCode,
  ExplorerChannelCloseEvent,
  ExplorerChannelLogger,
  ExplorerChannelState,
  ExplorerClientChannel,
  ExplorerHostChannel,
} from './types.js';

/**
 * Normalize a Node `worker_threads` MessagePort (`.on`) and a DOM/Electron
 * MessagePort (`addEventListener`) to the common `MessagePortLike` shape.
 *
 * Node's MessagePort wraps listeners in its own bookkeeping, so the
 * `removeEventListener` returned here cannot detach a specific listener —
 * it stays a no-op, as it always has. That used to mean a detached session
 * could still observe messages; the channel now gates delivery on its own
 * state, so CH-006 holds even when the underlying listener is still bound.
 */
export function adaptPort(port: unknown): MessagePortLike {
  const p = port as {
    postMessage?: (m: unknown, t?: readonly unknown[]) => void;
    addEventListener?: MessagePortLike['addEventListener'];
    removeEventListener?: MessagePortLike['removeEventListener'];
    on?: (event: string, listener: (data: unknown) => void) => unknown;
    start?: () => void;
    close?: () => void;
  };
  if (typeof p.addEventListener === 'function') {
    return port as MessagePortLike;
  }
  if (typeof p.on === 'function') {
    return {
      postMessage: (m, t) => p.postMessage!(m, t),
      addEventListener: (_type, listener) => {
        p.on!('message', (data) => listener({ data }));
      },
      removeEventListener: () => {
        /* no-op on Node MessagePort — see the doc comment above */
      },
      start: () => p.start?.(),
      close: () => p.close?.(),
    };
  }
  throw new Error('port does not satisfy MessagePortLike (no addEventListener or on)');
}

export interface MessagePortChannelOptions {
  readonly logger?: ExplorerChannelLogger;
}

class MessagePortChannel<TOutbound, TInbound> implements ExplorerChannel<TOutbound, TInbound> {
  readonly #port: MessagePortLike;
  readonly #messages: ListenerSet<TInbound>;
  readonly #closes: ListenerSet<ExplorerChannelCloseEvent>;
  readonly #onPortMessage: (ev: { data: unknown }) => void;
  #state: ExplorerChannelState = 'open';
  #closeEvent: ExplorerChannelCloseEvent | undefined;

  constructor(rawPort: unknown, options?: MessagePortChannelOptions) {
    const logger = options?.logger ?? NOOP_LOGGER;
    this.#port = adaptPort(rawPort);
    this.#messages = new ListenerSet<TInbound>('channel message', logger);
    this.#closes = new ListenerSet<ExplorerChannelCloseEvent>('channel close', logger);

    this.#onPortMessage = (ev: { data: unknown }): void => {
      // CH-006 — a closed channel delivers nothing, even if the underlying
      // port listener could not be detached (Node MessagePort).
      if (this.#state !== 'open') return;
      this.#messages.emit(ev.data as TInbound);
    };
    this.#port.addEventListener('message', this.#onPortMessage);
    this.#port.start?.();
  }

  get state(): ExplorerChannelState {
    return this.#state;
  }

  /** Always 0 — `postMessage` accepts synchronously. See the interface doc. */
  get bufferedBytes(): number {
    return 0;
  }

  send(message: TOutbound): void {
    if (this.#state !== 'open') {
      throw new Error(`ExplorerChannel is ${this.#state}; cannot send`);
    }
    try {
      this.#port.postMessage(message);
    } catch (err) {
      // A throwing postMessage means the port is gone. Close with the
      // specific cause, then rethrow so the caller's existing failure path
      // (the host detaches the session) still runs.
      this.#shutdown('TRANSPORT_ERROR', 'postMessage failed', err);
      throw err;
    }
  }

  /**
   * CH-004. `postMessage` hands off synchronously, so everything queued
   * before this call is already accepted; resolving on a microtask keeps
   * `drain()` awaitable without inventing a delay.
   */
  drain(): Promise<void> {
    return Promise.resolve();
  }

  onMessage(listener: (message: TInbound) => void): Disposable {
    return this.#messages.add(listener);
  }

  onClose(listener: (event: ExplorerChannelCloseEvent) => void): Disposable {
    // Subscribing after the channel already closed would otherwise never
    // fire. Deliver the terminal state on a microtask instead of dropping it.
    if (this.#state === 'closed') {
      const event = this.#closeEvent ?? { code: 'LOCAL_CLOSE' as const };
      queueMicrotask(() => listener(event));
      return { dispose: () => {} };
    }
    return this.#closes.add(listener);
  }

  close(reason?: string): void {
    this.#shutdown('LOCAL_CLOSE', reason);
  }

  dispose(): void {
    this.close('disposed');
  }

  /** CH-005 — exactly one close event, on the first transition out of `open`. */
  #shutdown(code: ExplorerChannelCloseCode, reason?: string, cause?: unknown): void {
    if (this.#state !== 'open') return;
    this.#state = 'closing';
    const event: ExplorerChannelCloseEvent = { code, reason, cause };
    this.#closeEvent = event;
    try {
      this.#port.removeEventListener('message', this.#onPortMessage);
      this.#port.close?.();
    } catch {
      // Tearing down a already-dead port is not interesting; the close
      // event below still fires with the original code.
    }
    this.#state = 'closed';
    this.#closes.emit(event);
    this.#closes.clear();
    this.#messages.clear();
  }
}

export function createMessagePortHostChannel(
  port: MessagePortLike,
  options?: MessagePortChannelOptions,
): ExplorerHostChannel {
  return new MessagePortChannel<HostToClientMessage, ClientToHostMessage>(port, options);
}

export function createMessagePortClientChannel(
  port: MessagePortLike,
  options?: MessagePortChannelOptions,
): ExplorerClientChannel {
  return new MessagePortChannel<ClientToHostMessage, HostToClientMessage>(port, options);
}

/** Duck-type an already-built channel apart from a raw MessagePort. */
export function isExplorerChannel(value: unknown): value is ExplorerChannel<unknown, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<ExplorerChannel<unknown, unknown>>;
  return (
    typeof c.send === 'function' &&
    typeof c.onMessage === 'function' &&
    typeof c.onClose === 'function' &&
    typeof c.close === 'function'
  );
}
