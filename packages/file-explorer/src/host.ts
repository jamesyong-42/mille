// UtilityProcess-side entry — Phase 7 commits 7.1 + 7.3.
//
// `createFileExplorerHost` wraps a native `FileExplorer` and owns the
// per-MessagePort `Session` map. Each attached port gets its own
// expansion set, viewport, knownIds (for delta filtering in 7.5), and
// request-id counter. Attach/detach lifecycle is testable end-to-end
// via Node `worker_threads` MessageChannels — the same shape Electron's
// `MessageChannelMain` produces.
//
// 7.3 adds message routing: handshake -> snapshot, setExpanded -> delta
// (empty mirror until wave 3), setViewport -> fire-and-forget, mutate ->
// dispatchMutation -> mutateResult, call -> dispatchCall -> callResult,
// dispose -> detach. Version gating + handshake-first sequencing are
// enforced; malformed or wrong-version frames produce an `error` frame.
// Bulk mirror/delta payloads land in wave 3 via a shared encoder.

import { FileExplorer } from './client.js';
import type { EntryId, ExplorerOptions } from './client.js';
import { isFileSystemError } from './errors.js';
import {
  frame,
  isCompatibleVersion,
  validateFrameVersion,
} from './protocol.js';
import type { Disposable, FileExplorerHost, MessagePortLike } from './types.js';

/**
 * Per-connection session state. Owned by the host, one per attached port.
 */
interface Session {
  readonly id: number;
  readonly port: MessagePortLike;
  /** Expansion set this client has declared via `setExpanded`. */
  expanded: Set<number>;
  /** Current viewport window the client has requested. */
  viewport: { offset: number; limit: number; overscan: number };
  /**
   * Entry ids this session has already been told about. Phase 7.5 uses
   * this to filter deltas down to the rows the client actually knows —
   * new entries outside the client's viewport stay off the wire until
   * the viewport moves to cover them.
   */
  knownIds: Set<number>;
  /** Next request id to use on outgoing host->client frames. */
  nextReqId: number;
  /** Whether the handshake frame has been observed. */
  handshook: boolean;
  /** Teardown for the message listener + port. Replaced during attach. */
  detach: () => void;
}

/**
 * Normalize a Node `worker_threads::MessagePort` (uses `.on`/`.off`) and
 * a DOM/Electron `MessagePort` (uses `addEventListener`) down to the
 * common `MessagePortLike` shape the rest of the host works against.
 *
 * Node's MessagePort wraps listeners with its own bookkeeping, so
 * `removeEventListener` here is currently a no-op — the session's
 * `detach` relies on `port.close()` to drop the listener instead. Phase
 * 7.10 tightens this with per-listener bookkeeping.
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
      // TODO(7.10): per-listener bookkeeping so removeEventListener
      // actually detaches. close() below covers the common case.
      removeEventListener: () => {
        /* no-op on Node MessagePort */
      },
      start: () => p.start?.(),
      close: () => p.close?.(),
    };
  }
  throw new Error('port does not satisfy MessagePortLike (no addEventListener or on)');
}

class FileExplorerHostImpl implements FileExplorerHost {
  private readonly explorer: FileExplorer;
  private readonly sessions = new Map<number, Session>();
  private nextSessionId = 1;
  private disposed = false;

  constructor(options: ExplorerOptions) {
    this.explorer = new FileExplorer(options);
  }

  get local(): FileExplorer {
    return this.explorer;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  attachPort(rawPort: MessagePortLike): Disposable {
    if (this.disposed) {
      throw new Error('FileExplorerHost is disposed');
    }
    const port = adaptPort(rawPort);
    const id = this.nextSessionId++;
    const session: Session = {
      id,
      port,
      expanded: new Set<number>(),
      viewport: { offset: 0, limit: 0, overscan: 0 },
      knownIds: new Set<number>(),
      nextReqId: 1,
      handshook: false,
      detach: () => {
        /* replaced below */
      },
    };

    const onMessage = (evt: { data: unknown }): void => {
      this.handleMessage(session, evt.data);
    };
    port.addEventListener('message', onMessage);
    port.start?.();

    session.detach = (): void => {
      port.removeEventListener('message', onMessage);
      port.close?.();
    };
    this.sessions.set(id, session);
    return { dispose: () => this.detachSession(id) };
  }

  private handleMessage(session: Session, data: unknown): void {
    const f = validateFrameVersion(data);
    if (!f) {
      this.sendError(session, 'EINVAL', 'malformed frame');
      return;
    }
    if (!isCompatibleVersion(f.v)) {
      this.sendError(session, 'EUNSUPPORTED', `unsupported protocol v${f.v}`);
      return;
    }
    if (!session.handshook && f.type !== 'handshake') {
      this.sendError(session, 'EINVAL', 'expected handshake first');
      return;
    }
    switch (f.type) {
      case 'handshake':
        this.handleHandshake(session);
        return;
      case 'setExpanded':
        this.handleSetExpanded(session, f.body as { add?: number[]; remove?: number[] });
        return;
      case 'setViewport':
        this.handleSetViewport(
          session,
          f.body as { offset: number; limit: number; overscan?: number },
        );
        return;
      case 'mutate':
        void this.handleMutate(
          session,
          f.body as { reqId: number; op: string; args: Record<string, unknown> },
        );
        return;
      case 'call':
        void this.handleCall(
          session,
          f.body as { reqId: number; method: string; args: unknown[] },
        );
        return;
      case 'dispose':
        this.detachSession(session.id);
        return;
      default:
        this.sendError(session, 'EINVAL', `unknown message type: ${f.type}`);
    }
  }

  private handleHandshake(session: Session): void {
    session.handshook = true;
    const snap = this.explorer.getSnapshot();
    const roots = snap.roots().map((e) => e.id);
    const directChildCounts: Record<string, number> = {};
    for (const rid of roots) {
      const c = snap.directChildCount(rid);
      if (c !== null) directChildCounts[String(rid)] = c;
    }
    this.send(
      session,
      frame('snapshot', {
        version: snap.treeVersion,
        roots,
        // Wave 3 encodes real rows here via the shared bincode encoder.
        mirror: new ArrayBuffer(0),
        directChildCounts,
        viewport: new ArrayBuffer(0),
        visibleCount: 0,
      }),
    );
  }

  private handleSetExpanded(
    session: Session,
    body: { add?: number[]; remove?: number[] },
  ): void {
    for (const id of body.add ?? []) session.expanded.add(id);
    for (const id of body.remove ?? []) session.expanded.delete(id);
    // Wave 2: empty delta — real row diffs land in wave 3 once the
    // shared encoder exists. The version bump still lets the client
    // know the session state moved.
    this.send(
      session,
      frame('delta', {
        version: this.explorer.getTreeVersion(),
        changedIds: [],
        removedIds: [],
        directChildCounts: {},
        newVisibleCount: 0,
        coarseSubtrees: [],
        subtreeDirty: [],
        subtreeResynced: [],
      }),
    );
  }

  private handleSetViewport(
    session: Session,
    body: { offset: number; limit: number; overscan?: number },
  ): void {
    session.viewport = {
      offset: body.offset,
      limit: body.limit,
      overscan: body.overscan ?? 0,
    };
    // No response — viewport is fire-and-forget. Wave 3 pushes a
    // viewport-patch delta if the window moved enough to matter.
  }

  private async handleMutate(
    session: Session,
    body: { reqId: number; op: string; args: Record<string, unknown> },
  ): Promise<void> {
    try {
      const result = await this.dispatchMutation(body.op, body.args);
      this.send(session, frame('mutateResult', { reqId: body.reqId, result }));
    } catch (e: unknown) {
      const err = toErrorPayload(e);
      this.send(
        session,
        frame('mutateResult', { reqId: body.reqId, result: null, error: err }),
      );
    }
  }

  private async dispatchMutation(op: string, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'create':
        return this.explorer.create(
          args.parentId as EntryId,
          args.name as string,
          args.kind as number,
        );
      case 'rename':
        return this.explorer.rename(args.id as EntryId, args.newName as string);
      case 'move':
        return this.explorer.move(
          args.id as EntryId,
          args.newParentId as EntryId,
          args.newName as string | undefined,
        );
      case 'delete':
        return this.explorer.delete(
          args.id as EntryId,
          args.options as { trash?: boolean; recursive?: boolean } | undefined,
        );
      case 'copy':
        return this.explorer.copy(
          args.id as EntryId,
          args.newParentId as EntryId,
          args.newName as string | undefined,
        );
      case 'readFile': {
        const buf = await this.explorer.readFile(args.id as EntryId);
        // Convert Uint8Array to a plain array so structured clone ships
        // it through the wire without being mistaken for a TypedArray.
        return Array.from(buf);
      }
      case 'readText':
        return this.explorer.readText(
          args.id as EntryId,
          args.encoding as string | undefined,
        );
      case 'writeFile':
        return this.explorer.writeFile(
          args.id as EntryId,
          new Uint8Array(args.data as ArrayLike<number>),
          args.options as { atomic?: boolean } | undefined,
        );
      default:
        throw new Error(`unknown op: ${op}`);
    }
  }

  private async handleCall(
    session: Session,
    body: { reqId: number; method: string; args: unknown[] },
  ): Promise<void> {
    try {
      const result = await this.dispatchCall(body.method, body.args);
      this.send(session, frame('callResult', { reqId: body.reqId, result }));
    } catch (e: unknown) {
      const err = toErrorPayload(e);
      this.send(
        session,
        frame('callResult', { reqId: body.reqId, result: null, error: err }),
      );
    }
  }

  private async dispatchCall(method: string, _args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'getTreeVersion':
        return this.explorer.getTreeVersion();
      case 'capabilities':
        return this.explorer.capabilities;
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private send(session: Session, msg: unknown): void {
    try {
      session.port.postMessage(msg);
    } catch {
      // Port may be closed mid-flight. Detach this session quietly so
      // the host can keep serving other sessions.
      this.detachSession(session.id);
    }
  }

  private sendError(session: Session, code: string, message: string): void {
    this.send(session, frame('error', { code, message }));
  }

  private detachSession(id: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.detach();
    this.sessions.delete(id);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.sessions.keys()]) {
      this.detachSession(id);
    }
    await this.explorer.dispose();
  }
}

function toErrorPayload(e: unknown): { code: string; message: string; path?: string } {
  if (isFileSystemError(e)) {
    const payload: { code: string; message: string; path?: string } = {
      code: e.code,
      message: e.message,
    };
    if (e.path !== undefined) payload.path = e.path;
    return payload;
  }
  const msg = (e as { message?: unknown } | null)?.message;
  return {
    code: 'EUNKNOWN',
    message: typeof msg === 'string' ? msg : String(e),
  };
}

/**
 * Construct a host around a native `FileExplorer`. Returns a handle
 * whose `attachPort` registers renderer sessions and whose `local`
 * exposes the explorer for same-process consumers (SCM providers,
 * background indexers) that don't need port indirection.
 */
export async function createFileExplorerHost(
  options: ExplorerOptions,
): Promise<FileExplorerHost> {
  return new FileExplorerHostImpl(options);
}

export type { FileExplorerHost, MessagePortLike } from './types.js';
