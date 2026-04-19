// Port-backed FileExplorer client — Phase 7 commit 7.4.
//
// Companion to createFileExplorerHost. `connectFileExplorer(port)` attaches
// to a MessagePort-shaped transport (Node worker_threads, Electron
// MessageChannelMain, or DOM MessageChannel), completes the protocol
// handshake, and returns a PortFileExplorer whose surface mirrors the
// typed FileExplorer class — but every method tunnels through the wire.
//
// Wave 2 scope:
//   - handshake handshake/snapshot wiring + treeVersion tracking
//   - mutate / call reqId multiplexing with typed FileSystemError on reject
//   - on('change') fires on every delta arrival
//   - dispose() rejects outstanding requests with ECANCELED
//
// Wave 3 fills in real mirror decoding so `getSnapshot().visibleRows()`
// and `getById()` return real data; the current MirrorSnapshot stub just
// exposes the handshake's `roots` list.

import { FileSystemError, type ErrorCode } from './errors.js';
import { frame, PROTOCOL_VERSION, validateFrameVersion } from './protocol.js';
import type { Disposable, MessagePortLike } from './types.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface ClientOptions {
  readonly prefetchRows?: number;
  readonly mirrorCap?: number;
}

type ChangeListener = () => void;

/**
 * Normalize a Node `worker_threads::MessagePort` onto the common
 * MessagePortLike shape. Mirrors host.ts's adaptPort.
 */
function adaptPort(port: unknown): MessagePortLike {
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
        /* no-op on Node MessagePort — close() handles teardown */
      },
      start: () => p.start?.(),
      close: () => p.close?.(),
    };
  }
  throw new Error('port does not satisfy MessagePortLike (no addEventListener or on)');
}

/** Stub snapshot for wave 2 — just carries the roots list + treeVersion. */
export class PortMirrorSnapshot {
  constructor(
    readonly treeVersion: number,
    private readonly rootsList: readonly number[],
  ) {}

  get decorationVersion(): number {
    return 0;
  }

  /** Wave 3 returns real Entry records from the decoded mirror. */
  roots(): readonly { id: number }[] {
    return this.rootsList.map((id) => ({ id }));
  }
}

/**
 * Renderer-side FileExplorer proxy. Every mutation routes through the
 * port; every reqId gets a pending promise that resolves on the matching
 * mutateResult/callResult frame or rejects with a typed FileSystemError.
 */
export class PortFileExplorer {
  private readonly port: MessagePortLike;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly changeListeners = new Set<ChangeListener>();
  private nextReqId = 1;
  private treeVersion = 0;
  private rootIds: readonly number[] = [];
  private readonly handshakeReady: Promise<void>;
  private handshakeResolve!: () => void;
  private handshakeReject!: (reason: unknown) => void;
  private disposed = false;

  constructor(rawPort: MessagePortLike, options?: ClientOptions) {
    this.port = adaptPort(rawPort);
    this.handshakeReady = new Promise((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
    });
    this.port.addEventListener('message', (ev) => this.handleMessage(ev.data));
    this.port.start?.();
    this.port.postMessage(
      frame('handshake', {
        version: PROTOCOL_VERSION,
        clientId: `c-${Math.random().toString(36).slice(2, 10)}`,
        options: options ?? {},
      }),
    );
  }

  /** Resolves once the host has replied with its initial snapshot. */
  ready(): Promise<void> {
    return this.handshakeReady;
  }

  getTreeVersion(): number {
    return this.treeVersion;
  }

  getSnapshot(): PortMirrorSnapshot {
    return new PortMirrorSnapshot(this.treeVersion, this.rootIds);
  }

  /**
   * Subscribe to change bumps. Wave 2 fires on delta arrivals only;
   * other channels (event/batch/warning/error/ready) land in wave 3+.
   */
  on(event: string, listener: (...args: unknown[]) => void): Disposable {
    if (event === 'change') {
      const wrapped: ChangeListener = () => listener();
      this.changeListeners.add(wrapped);
      return {
        dispose: () => {
          this.changeListeners.delete(wrapped);
        },
      };
    }
    return { dispose: () => undefined };
  }

  /** Push a fresh expansion diff to the host. */
  setExpanded(diff: { add?: readonly number[]; remove?: readonly number[] }): void {
    this.sendAfterReady(
      frame('setExpanded', {
        add: diff.add ? [...diff.add] : [],
        remove: diff.remove ? [...diff.remove] : [],
      }),
    );
  }

  /** Fire-and-forget viewport update. */
  setViewport(window: { offset: number; limit: number; overscan?: number }): void {
    const body: { offset: number; limit: number; overscan?: number } = {
      offset: window.offset,
      limit: window.limit,
    };
    if (window.overscan !== undefined) body.overscan = window.overscan;
    this.sendAfterReady(frame('setViewport', body));
  }

  // ─── Mutations ────────────────────────────────────────────────────

  create(parentId: number, name: string, kind: number): Promise<unknown> {
    return this.mutate('create', { parentId, name, kind });
  }

  rename(id: number, newName: string): Promise<unknown> {
    return this.mutate('rename', { id, newName });
  }

  move(id: number, newParentId: number, newName?: string): Promise<unknown> {
    const args: Record<string, unknown> = { id, newParentId };
    if (newName !== undefined) args.newName = newName;
    return this.mutate('move', args);
  }

  delete(
    id: number,
    options?: { trash?: boolean; recursive?: boolean },
  ): Promise<unknown> {
    const args: Record<string, unknown> = { id };
    if (options !== undefined) args.options = options;
    return this.mutate('delete', args);
  }

  copy(id: number, newParentId: number, newName?: string): Promise<unknown> {
    const args: Record<string, unknown> = { id, newParentId };
    if (newName !== undefined) args.newName = newName;
    return this.mutate('copy', args);
  }

  async readFile(id: number): Promise<Uint8Array> {
    const data = (await this.mutate('readFile', { id })) as number[];
    return Uint8Array.from(data);
  }

  readText(id: number, encoding?: string): Promise<unknown> {
    const args: Record<string, unknown> = { id };
    if (encoding !== undefined) args.encoding = encoding;
    return this.mutate('readText', args);
  }

  writeFile(
    id: number,
    data: Uint8Array,
    options?: { atomic?: boolean },
  ): Promise<unknown> {
    const args: Record<string, unknown> = { id, data: Array.from(data) };
    if (options !== undefined) args.options = options;
    return this.mutate('writeFile', args);
  }

  private async mutate(op: string, args: Record<string, unknown>): Promise<unknown> {
    await this.handshakeReady;
    if (this.disposed) {
      throw new FileSystemError('ECANCELED', 'explorer disposed');
    }
    const reqId = this.nextReqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      try {
        this.port.postMessage(frame('mutate', { reqId, op, args }));
      } catch (e) {
        this.pending.delete(reqId);
        reject(e);
      }
    });
  }

  /** Non-mutating RPC channel (e.g. getTreeVersion). */
  async call(method: string, args: unknown[] = []): Promise<unknown> {
    await this.handshakeReady;
    if (this.disposed) {
      throw new FileSystemError('ECANCELED', 'explorer disposed');
    }
    const reqId = this.nextReqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      try {
        this.port.postMessage(frame('call', { reqId, method, args }));
      } catch (e) {
        this.pending.delete(reqId);
        reject(e);
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Best-effort notify the host before tearing down. If the port is
    // already closed the send will throw and we swallow it.
    try {
      this.port.postMessage(frame('dispose', {}));
    } catch {
      /* ignore */
    }
    for (const [, p] of this.pending) {
      p.reject(new FileSystemError('ECANCELED', 'explorer disposed'));
    }
    this.pending.clear();
    this.port.close?.();
  }

  private sendAfterReady(msg: unknown): void {
    void this.handshakeReady.then(() => {
      if (this.disposed) return;
      try {
        this.port.postMessage(msg);
      } catch {
        /* port closed; ignore */
      }
    });
  }

  private handleMessage(data: unknown): void {
    const f = validateFrameVersion(data);
    if (!f) return;
    switch (f.type) {
      case 'snapshot':
        this.handleSnapshot(
          f.body as { version: number; roots: number[] },
        );
        return;
      case 'delta':
        this.handleDelta(f.body as { version: number });
        return;
      case 'mutateResult':
      case 'callResult':
        this.handleResult(
          f.body as {
            reqId: number;
            result: unknown;
            error?: { code: string; message: string; path?: string };
          },
        );
        return;
      case 'error':
        this.handleError(f.body as { code: string; message: string });
        return;
      // event / warning / batch / ready land in wave 3+
      default:
        return;
    }
  }

  private handleSnapshot(body: { version: number; roots: number[] }): void {
    this.treeVersion = body.version;
    this.rootIds = body.roots;
    this.handshakeResolve();
    this.fireChange();
  }

  private handleDelta(body: { version: number }): void {
    this.treeVersion = body.version;
    this.fireChange();
  }

  private handleResult(body: {
    reqId: number;
    result: unknown;
    error?: { code: string; message: string; path?: string };
  }): void {
    const pending = this.pending.get(body.reqId);
    if (!pending) return;
    this.pending.delete(body.reqId);
    if (body.error) {
      pending.reject(
        new FileSystemError(
          body.error.code as ErrorCode,
          body.error.message,
          body.error.path,
        ),
      );
    } else {
      pending.resolve(body.result);
    }
  }

  private handleError(body: { code: string; message: string }): void {
    const err = new FileSystemError(body.code as ErrorCode, body.message);
    // Session-level failure. If we haven't handshaken yet, fail ready().
    // Either way, reject every pending request so callers bubble out
    // rather than hanging.
    this.handshakeReject(err);
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private fireChange(): void {
    for (const l of this.changeListeners) {
      try {
        l();
      } catch {
        /* swallow listener errors so one bad subscriber can't block others */
      }
    }
  }
}

/**
 * Renderer-side factory. Takes a MessagePort and resolves once the
 * handshake completes and the initial snapshot has arrived. Mirrors
 * the api.d.ts signature.
 */
export async function connectFileExplorer(
  port: MessagePortLike,
  options?: ClientOptions,
): Promise<PortFileExplorer> {
  const fx = new PortFileExplorer(port, options);
  await fx.ready();
  return fx;
}
