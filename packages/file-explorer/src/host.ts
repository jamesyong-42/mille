// UtilityProcess-side entry — Phase 7 commit 7.1.
//
// `createFileExplorerHost` wraps a native `FileExplorer` and owns the
// per-MessagePort `Session` map. Each attached port gets its own
// expansion set, viewport, knownIds (for delta filtering in 7.5), and
// request-id counter. Attach/detach lifecycle is testable end-to-end
// via Node `worker_threads` MessageChannels — the same shape Electron's
// `MessageChannelMain` produces.
//
// Protocol-message routing + delta fan-out land in later commits
// (7.3 snapshot emit, 7.4 client wrapper, 7.5 delta filtering). For
// now the message handler is a no-op; the tests here exercise session
// bookkeeping only.

import { FileExplorer } from './client.js';
import type { ExplorerOptions } from './client.js';
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

  attachPort(port: MessagePortLike): Disposable {
    if (this.disposed) {
      throw new Error('FileExplorerHost is disposed');
    }
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
      // Phase 7.3 owns the actual message routing. For 7.1 we only need
      // to prove the listener is wired — the protocol handler is a no-op.
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

  private handleMessage(_session: Session, _data: unknown): void {
    // Intentionally empty — handshake + protocol dispatch lands in 7.3.
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
