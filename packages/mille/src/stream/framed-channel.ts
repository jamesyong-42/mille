// ExplorerChannel over a Node Duplex (SPEC §11.8, §20.1).
//
// This is the transport that makes remote workspaces possible. It takes any
// Duplex — a PassThrough in tests, a TCP socket, a Truffle mesh socket —
// and presents the same ExplorerChannel the MessagePort adapter does, so
// neither the host nor the client can tell the difference.
//
// Write scheduling is deliberate (SPEC §20.1): frames queue *here*, and one
// is handed to the stream at a time. When `write()` returns false nothing
// further is written until `'drain'` fires. That means `bufferedBytes`
// counts bytes we are holding, not bytes the OS already owns, and the hard
// limit closes the channel instead of growing without bound.

import type { Duplex } from 'node:stream';

import type { Disposable } from '../types.js';
import type { ClientToHostMessage, HostToClientMessage } from '../protocol.js';
import { ListenerSet, NOOP_LOGGER } from '../channel/emitter.js';
import type {
  ExplorerChannel,
  ExplorerChannelCloseCode,
  ExplorerChannelCloseEvent,
  ExplorerChannelLogger,
  ExplorerChannelState,
  ExplorerClientChannel,
  ExplorerHostChannel,
} from '../channel/types.js';
import { encodeFrame } from './codec.js';
import { FrameDecoder } from './decoder.js';
import { resolveLimits, type FramedStreamLimits, type FramedStreamLimitsInput } from './limits.js';

export interface FramedStreamChannelOptions extends FramedStreamLimitsInput {
  readonly logger?: ExplorerChannelLogger;
}

interface DrainWaiter {
  /** Cumulative enqueued-byte mark this waiter is waiting to pass. */
  readonly mark: number;
  readonly resolve: () => void;
}

class FramedStreamChannel<TOutbound, TInbound> implements ExplorerChannel<TOutbound, TInbound> {
  readonly #stream: Duplex;
  readonly #limits: FramedStreamLimits;
  readonly #logger: ExplorerChannelLogger;
  readonly #messages: ListenerSet<TInbound>;
  readonly #closes: ListenerSet<ExplorerChannelCloseEvent>;
  readonly #decoder: FrameDecoder;

  /** Encoded frames not yet handed to the stream. */
  readonly #queue: Uint8Array[] = [];
  #queuedBytes = 0;
  /** Cumulative bytes ever enqueued / ever written, for drain() ordering. */
  #enqueuedTotal = 0;
  #writtenTotal = 0;
  #drainWaiters: DrainWaiter[] = [];
  #writable = true;
  #softWarned = false;

  #state: ExplorerChannelState = 'open';
  #closeEvent: ExplorerChannelCloseEvent | undefined;

  constructor(stream: Duplex, options?: FramedStreamChannelOptions) {
    this.#stream = stream;
    this.#limits = resolveLimits(options);
    this.#logger = options?.logger ?? NOOP_LOGGER;
    this.#messages = new ListenerSet<TInbound>('channel message', this.#logger);
    this.#closes = new ListenerSet<ExplorerChannelCloseEvent>('channel close', this.#logger);
    this.#decoder = new FrameDecoder(this.#limits);

    stream.on('data', this.#onData);
    stream.on('drain', this.#onDrain);
    stream.on('error', this.#onError);
    stream.on('end', this.#onEnd);
    stream.on('close', this.#onStreamClose);
  }

  get state(): ExplorerChannelState {
    return this.#state;
  }

  get bufferedBytes(): number {
    return this.#queuedBytes;
  }

  /** True once the queue passes the soft watermark; callers should await drain(). */
  get overSoftWatermark(): boolean {
    return this.#queuedBytes >= this.#limits.outboundSoftBytes;
  }

  send(message: TOutbound): void {
    if (this.#state !== 'open') {
      throw new Error(`ExplorerChannel is ${this.#state}; cannot send`);
    }
    // Encoding failures are the caller's bug (a cyclic or non-representable
    // message), not a transport fault — surface them without killing a
    // channel that is still perfectly healthy.
    const frame = encodeFrame(message, this.#limits);

    if (this.#queuedBytes + frame.byteLength > this.#limits.outboundHardBytes) {
      const err = new Error(
        `outbound queue would exceed ${this.#limits.outboundHardBytes} bytes; closing channel`,
      );
      this.#shutdown('BACKPRESSURE', 'outbound hard limit exceeded', err);
      throw err;
    }

    this.#queue.push(frame);
    this.#queuedBytes += frame.byteLength;
    this.#enqueuedTotal += frame.byteLength;

    if (!this.#softWarned && this.overSoftWatermark) {
      this.#softWarned = true;
      this.#logger.warn('outbound queue passed the soft watermark', {
        queuedBytes: this.#queuedBytes,
        softLimit: this.#limits.outboundSoftBytes,
      });
    }
    this.#pump();
  }

  drain(): Promise<void> {
    if (this.#writtenTotal >= this.#enqueuedTotal) return Promise.resolve();
    const mark = this.#enqueuedTotal;
    return new Promise<void>((resolve) => {
      this.#drainWaiters.push({ mark, resolve });
    });
  }

  onMessage(listener: (message: TInbound) => void): Disposable {
    return this.#messages.add(listener);
  }

  onClose(listener: (event: ExplorerChannelCloseEvent) => void): Disposable {
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

  // ─── internals ────────────────────────────────────────────────────────

  /**
   * Hand queued frames to the stream one at a time, stopping the moment it
   * signals backpressure. Resuming is `'drain'`'s job.
   */
  #pump(): void {
    while (this.#writable && this.#queue.length > 0 && this.#state === 'open') {
      const frame = this.#queue.shift()!;
      this.#queuedBytes -= frame.byteLength;
      this.#writtenTotal += frame.byteLength;
      let ok: boolean;
      try {
        ok = this.#stream.write(frame);
      } catch (err) {
        this.#shutdown('TRANSPORT_ERROR', 'stream write threw', err);
        return;
      }
      if (!ok) this.#writable = false;
    }
    if (this.#queuedBytes < this.#limits.outboundSoftBytes) this.#softWarned = false;
    this.#settleDrainWaiters();
  }

  #settleDrainWaiters(): void {
    if (this.#drainWaiters.length === 0) return;
    const ready = this.#drainWaiters.filter((w) => this.#writtenTotal >= w.mark);
    if (ready.length === 0) return;
    this.#drainWaiters = this.#drainWaiters.filter((w) => this.#writtenTotal < w.mark);
    for (const w of ready) w.resolve();
  }

  readonly #onDrain = (): void => {
    this.#writable = true;
    this.#pump();
  };

  readonly #onData = (chunk: Buffer | string): void => {
    if (this.#state !== 'open') return;
    const bytes =
      typeof chunk === 'string'
        ? new TextEncoder().encode(chunk)
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let messages: unknown[];
    try {
      messages = this.#decoder.push(bytes);
    } catch (err) {
      // A malformed frame terminates this session only — never the shared
      // host (SPEC NFR-005).
      this.#shutdown('PROTOCOL_ERROR', (err as Error).message, err);
      return;
    }
    for (const message of messages) {
      if (this.#state !== 'open') return;
      this.#messages.emit(message as TInbound);
    }
  };

  readonly #onError = (err: Error): void => {
    this.#shutdown('TRANSPORT_ERROR', err.message, err);
  };

  /**
   * A stream with no `'error'` listener *throws* when one is emitted, and
   * tearing a Duplex down is a common way to produce one (destroying one
   * half of a `Duplex.from` pair aborts the other with `ABORT_ERR`). The
   * channel therefore always keeps an error listener attached — this one
   * replaces `#onError` at shutdown so late failures are logged instead of
   * escaping as an uncaught exception.
   */
  readonly #swallowError = (err: Error): void => {
    this.#logger.warn('stream error after channel close', err);
  };

  readonly #onEnd = (): void => {
    this.#shutdown('REMOTE_CLOSE', 'peer ended the stream');
  };

  readonly #onStreamClose = (): void => {
    this.#shutdown('REMOTE_CLOSE', 'stream closed');
  };

  #shutdown(code: ExplorerChannelCloseCode, reason?: string, cause?: unknown): void {
    if (this.#state !== 'open') return;
    this.#state = 'closing';
    const event: ExplorerChannelCloseEvent = { code, reason, cause };
    this.#closeEvent = event;

    this.#stream.off('data', this.#onData);
    this.#stream.off('drain', this.#onDrain);
    this.#stream.off('end', this.#onEnd);
    this.#stream.off('close', this.#onStreamClose);
    // Swap, never drop: the stream must still have an error listener while
    // we tear it down. See #swallowError.
    this.#stream.off('error', this.#onError);
    this.#stream.on('error', this.#swallowError);

    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#decoder.reset();

    try {
      // end() flushes what the stream already accepted; destroy() would drop
      // it. A local close should still deliver frames we handed over.
      if (code === 'LOCAL_CLOSE') this.#stream.end();
      else this.#stream.destroy();
    } catch (err) {
      this.#logger.warn('closing the underlying stream threw', err);
    }

    this.#state = 'closed';
    // Anything awaiting drain will never be satisfied now; release them
    // rather than leaving the promises dangling forever.
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const w of waiters) w.resolve();

    this.#closes.emit(event);
    this.#closes.clear();
    this.#messages.clear();
  }
}

export function createFramedStreamHostChannel(
  stream: Duplex,
  options?: FramedStreamChannelOptions,
): ExplorerHostChannel {
  return new FramedStreamChannel<HostToClientMessage, ClientToHostMessage>(stream, options);
}

export function createFramedStreamClientChannel(
  stream: Duplex,
  options?: FramedStreamChannelOptions,
): ExplorerClientChannel {
  return new FramedStreamChannel<ClientToHostMessage, HostToClientMessage>(stream, options);
}
