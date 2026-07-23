// UtilityProcess-side entry — Phase 7 commits 7.1 + 7.3.
//
// `createFileExplorerHost` wraps a native `FileExplorer` and owns the
// per-MessagePort `Session` map. Each attached port gets its own
// expansion set, viewport, knownIds (for delta filtering in 7.5), and
// request-id counter. Attach/detach lifecycle is testable end-to-end
// via Node `worker_threads` MessageChannels — the same shape Electron's
// `MessageChannelMain` produces.
//
// 7.3 adds message routing: handshake -> snapshot, setExpanded -> delta,
// setViewport -> authoritative bounded patch, mutate ->
// dispatchMutation -> mutateResult, call -> dispatchCall -> callResult,
// dispose -> detach. Version gating + handshake-first sequencing are
// enforced; malformed or wrong-version frames produce an `error` frame.
// Root and viewport entry records use a shared bincode-compatible encoder.

import { FileExplorer, type Entry, type MirrorSnapshot } from './client.js';
import type { EntryId, ExplorerOptions } from './client.js';
import { DecorationStore, type Decoration, type DecorationProvider } from './decorations.js';
import { computeSessionDelta, type SessionView } from './delta.js';
import { isFileSystemError } from './errors.js';
import { encodeClientEntries } from './entry-codec.js';
import { encodeChildLists } from './child-list-codec.js';
import type { ClientEntry } from './mirror.js';
import {
  frame,
  isCompatibleVersion,
  validateFrameVersion,
  type DecorationOnWire,
  type DecorationsFrameBody,
} from './protocol.js';
import type { Disposable, FileExplorerHost, MessagePortLike } from './types.js';
import { compareNaturalNames } from './natural-sort.js';

/**
 * Project a public `Entry` into the mirror-local `ClientEntry` shape.
 * The public Entry uses `undefined`-holes for optional fields; the
 * binary and legacy JSON wire shapes use explicit `null` so round-trips
 * don't lose the distinction between "absent" and "present-undefined".
 */
function entryToClient(e: Entry): ClientEntry {
  return {
    id: e.id,
    parentId: e.parentId ?? null,
    name: e.name,
    kind: e.kind,
    size: e.size,
    mtimeMs: e.mtimeMs,
    ctimeMs: e.ctimeMs,
    symlinkTargetIsDir: e.symlinkTargetIsDir ?? null,
    pathSegments: e.pathSegments !== undefined ? [...e.pathSegments] : null,
    isIgnored: e.isIgnored,
    isReadonly: e.isReadonly,
    isHidden: e.isHidden,
  };
}

/** Stable IDE-style child order used as compact structural metadata. */
function sortedChildIds(snap: MirrorSnapshot, parentId: number): number[] {
  return [...snap.childrenOf(parentId)].sort((a, b) => {
    const ea = snap.getById(a);
    const eb = snap.getById(b);
    const ka = ea && (ea.kind === 1 || ea.symlinkTargetIsDir === true) ? 0 : 1;
    const kb = eb && (eb.kind === 1 || eb.symlinkTargetIsDir === true) ? 0 : 1;
    if (ka !== kb) return ka - kb;
    const na = ea?.name ?? '';
    const nb = eb?.name ?? '';
    return na === nb ? a - b : compareNaturalNames(na, nb);
  });
}

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
  /** Ids covered by the last viewport patch sent to this client. */
  viewportIds: Set<number>;
  /** Fallback row budget used when expansion precedes the first viewport. */
  prefetchRows: number;
  /** Whether this client advertised the packed child-order wire channel. */
  packedChildLists: boolean;
  /**
   * Entry ids whose full records this session has already received.
   * Phase 7.5 uses this to filter deltas down to hydrated rows —
   * new entries outside the client's viewport stay off the wire until
   * the viewport moves to cover them.
   */
  knownIds: Set<number>;
  /** Next request id to use on outgoing host->client frames. */
  nextReqId: number;
  /** Whether the handshake frame has been observed. */
  handshook: boolean;
  /**
   * Phase B1 — the last root-id set this session has been told about.
   * Populated with the ids shipped in the handshake's snapshot; the
   * per-tick delta builder compares the host's current roots against
   * this and re-ships the full list when the set changed. Kept per
   * session because sessions can attach at different phases of the
   * walker lifecycle — session A may have handshaken empty while B
   * handshook after a root was added.
   */
  lastRootSet: Set<number>;
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

/**
 * 16ms ≈ one render frame. SPEC §4.9 sizes the coalescer + fan-out tick
 * so the host never spends more than one frame between draining changes
 * and posting deltas. Adjusting this in tests is intentionally not
 * supported — the tick is an implementation detail.
 */
const TICK_MS = 16;

class FileExplorerHostImpl implements FileExplorerHost {
  private readonly explorer: FileExplorer;
  private readonly sessions = new Map<number, Session>();
  private nextSessionId = 1;
  private disposed = false;
  /**
   * Phase B2 — ids the host has already triggered a prefetch for. Guards
   * against re-firing a walk when a client re-expands the same folder
   * across sessions or after a collapse/re-expand cycle. The native
   * `populateFromPath` is already idempotent (snapshot-filter), but
   * skipping the call entirely also saves the NAPI hop. Keyed by id;
   * never pruned — prefetch is a one-shot per id per host lifetime.
   */
  private readonly prefetched: Set<number> = new Set();
  /** Phase B2 — initial-walk policy. See ExplorerOptions.initialWalk. */
  private readonly initialWalk: 'full' | 'roots-only' | 'none';
  /**
   * Phase B2 — has the initial walk (roots-only seeding) run yet? The
   * first `attachPort` triggers it so sessions can attach and handshake
   * before any filesystem work. Subsequent attaches skip the walk but
   * still ship whatever the store holds.
   */
  private initialWalkDone = false;
  /** setInterval handle for the fan-out tick. Null when idle. */
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  /**
   * Subtree roots flagged for coarse invalidation since the last tick.
   * Drained into each session's outgoing delta as `coarseSubtrees`.
   * Wired to the native watcher's Overflow signal in Phase 5 — exposed
   * now via `markSubtreeCoarse` so the protocol end is testable.
   */
  private pendingCoarseSubtrees: Set<number> = new Set();
  /**
   * Volatile-subtree markers per SPEC §4.9.10. A root cannot ride both
   * fields in the same delta — the mark* methods enforce the
   * dirty-xor-resynced invariant at enqueue time so the tick never has
   * to reconcile them.
   */
  private pendingSubtreeDirty: Set<number> = new Set();
  private pendingSubtreeResynced: Set<number> = new Set();
  /**
   * Serial promise chain all mutations hang off. SPEC §5.1's ordering
   * guarantee — delta fan-out to every session must precede the
   * initiator's mutateResult — falls out of enqueuing each mutation on
   * this single chain and awaiting inside the entry.
   */
  private mutationQueue: Promise<void> = Promise.resolve();
  /**
   * Phase A1 — shared decoration store. Any client that ships a
   * `decorations` frame merges into this store; the next tick's delta
   * fan-out piggybacks `decorationChangedIds` + serialized merged
   * decoration payload onto every session's delta frame.
   */
  private readonly decorationStore = new DecorationStore();
  /** Native watcher event bridge (overflow/coarse invalidation). */
  private readonly watcherEventSub: Disposable;
  /** Ids whose merged decorations changed since the last tick. */
  private pendingDecorationChangedIds: Set<number> = new Set();

  constructor(options: ExplorerOptions) {
    this.explorer = new FileExplorer(options);
    this.initialWalk = options.initialWalk ?? 'full';
    this.watcherEventSub = this.explorer.on('event', (raw) => {
      const event = raw as { kind?: string; id?: number } | undefined;
      if (event?.kind !== 'overflow' || typeof event.id !== 'number') return;
      // The native watcher has already reconciled this subtree before it
      // emits overflow. Force the next delta to replace the mirror's child
      // list and allow a later expansion to prefetch again if needed.
      this.prefetched.delete(event.id);
      this.markSubtreeCoarse(event.id);
    });
  }

  get local(): FileExplorer {
    return this.explorer;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  markSubtreeCoarse(rootId: number): void {
    this.pendingCoarseSubtrees.add(rootId);
  }

  markSubtreeDirty(rootId: number): void {
    this.pendingSubtreeDirty.add(rootId);
    // A root cannot be simultaneously dirty and resynced — the pair
    // maps to opposite transitions in VolatileTracker's flip/release
    // state machine. If a previous resynced hadn't drained yet, the
    // latest transition wins.
    this.pendingSubtreeResynced.delete(rootId);
  }

  markSubtreeResynced(rootId: number): void {
    this.pendingSubtreeResynced.add(rootId);
    this.pendingSubtreeDirty.delete(rootId);
  }

  /**
   * In-process decoration provider registration. Writes into the
   * host's DecorationStore (same store the `decorations` wire frame
   * feeds) so the next tick fans out to every attached session.
   *
   * `host.local.registerDecorationProvider` is NOT equivalent — that
   * registers against the `FileExplorer`'s independent DecorationStore
   * and decorations never reach clients. Use this method for any
   * provider that should be visible to renderer sessions.
   */
  registerDecorationProvider(rawProvider: unknown): Disposable {
    if (this.disposed) {
      throw new Error('FileExplorerHost is disposed');
    }
    const provider = rawProvider as DecorationProvider;
    const sub = provider.onDidChange(async (ids) => {
      const changed: number[] = [];
      for (const id of ids) {
        try {
          const maybe = provider.provide({ id });
          const d =
            maybe !== null && typeof maybe === 'object' && 'then' in maybe
              ? await maybe
              : (maybe as Decoration | null);
          if (this.decorationStore.setForProvider(provider.id, id, d ?? null)) {
            changed.push(id);
          }
        } catch {
          // Swallow provider errors — a buggy provider shouldn't
          // crash the host. Matches FileExplorer's behaviour.
        }
      }
      if (changed.length > 0) {
        this.decorationStore.bump(changed);
        for (const id of changed) this.pendingDecorationChangedIds.add(id);
      }
    });
    return {
      dispose: () => {
        sub.dispose();
        const cleared = this.decorationStore.removeProvider(provider.id);
        if (cleared.length > 0) {
          this.decorationStore.bump(cleared);
          for (const id of cleared) this.pendingDecorationChangedIds.add(id);
        }
      },
    };
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
      viewportIds: new Set<number>(),
      prefetchRows: 100,
      packedChildLists: false,
      knownIds: new Set<number>(),
      nextReqId: 1,
      handshook: false,
      lastRootSet: new Set<number>(),
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
    this.ensureTick();

    // Phase B2 — kick off the configured initial walk on first attach.
    // Done non-blocking so handshake can fire immediately; `roots-only`
    // drops root Entry records into the store within one NAPI hop, and
    // the next tick's delta fan-out ships `roots` to every attached
    // session. Errors surface as warnings (not fatal — an unreachable
    // root is the user's concern, not the host's).
    this.ensureInitialWalk();

    return { dispose: () => this.detachSession(id) };
  }

  /**
   * Phase B2 — run the configured initial walk exactly once, lazily, at
   * the first `attachPort`. `'full'` is a no-op here (the consumer is
   * expected to drive `populateFromRoots` themselves — back-compat with
   * v0.1). `'roots-only'` walks each configured root at depth 0 so root
   * Entry records exist in the store before the client asks to expand.
   * `'none'` is a no-op (consumer handles hydration end-to-end).
   */
  private ensureInitialWalk(): void {
    if (this.initialWalkDone) return;
    this.initialWalkDone = true;
    if (this.initialWalk === 'full' || this.initialWalk === 'none') return;
    // roots-only — walk each configured root at depth 0. The native
    // `populateFromPath` with depth=0 + includeRoot=true seeds only the
    // root Entry; children arrive when a client expands the root.
    void this.doRootsOnlyWalk();
  }

  private async doRootsOnlyWalk(): Promise<void> {
    // Reach into the Rust-configured roots via the raw native binding.
    // The TS-side `FileExplorer` doesn't expose them separately; we use
    // the wrapper's internal knowledge of the configured root paths.
    // Rather than reconstruct them, we defer to the typed wrapper:
    // `FileExplorer` accepts `Uri | string` roots and stores them on
    // `this.rootPaths` (B2 addition). The public surface is
    // `populateFromRoots` at full depth, but for roots-only we call
    // the native `populateFromPath` per root at depth 0.
    const rootsInternal = (this.explorer as unknown as { rootPaths?: readonly string[] }).rootPaths;
    if (!rootsInternal || rootsInternal.length === 0) return;
    const nativeFx = (
      this.explorer as unknown as {
        nativeFx?: {
          populateFromPath?: (p: string, d?: number | null, r?: boolean | null) => Promise<number>;
        };
      }
    ).nativeFx;
    if (!nativeFx || typeof nativeFx.populateFromPath !== 'function') {
      // Older native builds. Silently fall back to nothing; the
      // playground's setExpanded-triggered prefetch still fills the
      // root's children on first expansion.
      return;
    }
    for (const rootPath of rootsInternal) {
      try {
        // Invoke as a method on nativeFx so napi-rs preserves the
        // receiver — destructuring the method ref and calling it
        // bare drops `this` and throws TypeError: Illegal invocation.
        await nativeFx.populateFromPath(rootPath, 0, true);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[mille] initialWalk: roots-only walk failed for ${rootPath}:`, e);
      }
    }
  }

  /** Start the 16ms fan-out tick if it isn't already running. */
  private ensureTick(): void {
    if (this.tickHandle !== null || this.disposed) return;
    this.tickHandle = setInterval(() => this.tick(), TICK_MS);
    // Don't keep the process alive just for the tick. Node's default
    // setInterval ref() behaviour would otherwise prevent graceful
    // shutdown in host harnesses that rely on the event loop draining.
    const h = this.tickHandle as unknown as { unref?: () => void };
    h.unref?.();
  }

  /** Stop the tick if it's running — called once sessionCount hits 0. */
  private stopTick(): void {
    if (this.tickHandle === null) return;
    clearInterval(this.tickHandle);
    this.tickHandle = null;
  }

  /**
   * Drain one ChangeSet from the native and fan out per-session deltas.
   *
   * No-op fast path when the ChangeSet is empty (quiet ticks): Phase 7's
   * tick loop runs at 60Hz, so idle hosts pay only a single NAPI call
   * per 16ms. Wave 4 adds a dirty-flag bypass if even that shows up on a
   * flame graph.
   */
  private tick(): void {
    if (this.disposed || this.sessions.size === 0) return;
    const cs = this.explorer.takePendingChanges();
    const changeSetEmpty =
      cs.changedIds.length === 0 &&
      cs.childSetChanged.length === 0 &&
      cs.subtreeRootsChanged.length === 0 &&
      cs.reparentedIds.length === 0;

    // Drain pending subtree markers. Doing this once per tick (not once
    // per session) guarantees all attached sessions see the same marker
    // set in the delta they receive this frame.
    const coarse = this.pendingCoarseSubtrees.size > 0 ? [...this.pendingCoarseSubtrees] : [];
    const subtreeDirty = this.pendingSubtreeDirty.size > 0 ? [...this.pendingSubtreeDirty] : [];
    const subtreeResynced =
      this.pendingSubtreeResynced.size > 0 ? [...this.pendingSubtreeResynced] : [];
    if (coarse.length > 0) this.pendingCoarseSubtrees.clear();
    if (subtreeDirty.length > 0) this.pendingSubtreeDirty.clear();
    if (subtreeResynced.length > 0) this.pendingSubtreeResynced.clear();

    // Phase A1 — drain pending decoration changes. Every attached
    // session sees the same fan-out; absence of a decoration change
    // leaves these fields empty on the outgoing delta.
    const decorationChangedIds =
      this.pendingDecorationChangedIds.size > 0 ? [...this.pendingDecorationChangedIds] : [];
    if (decorationChangedIds.length > 0) this.pendingDecorationChangedIds.clear();

    // Phase B1 — check whether any session's root view is out of date.
    // Root changes usually show up in the ChangeSet too (the walker
    // adds the root entry to the native store), but we guard
    // independently so a stray root-set change without an attendant
    // ChangeSet still reaches the wire.
    let rootsChangedAnySession = false;
    if (
      changeSetEmpty &&
      coarse.length === 0 &&
      subtreeDirty.length === 0 &&
      subtreeResynced.length === 0 &&
      decorationChangedIds.length === 0
    ) {
      const currentRootIds = this.explorer
        .getSnapshot()
        .roots()
        .map((e) => e.id);
      const currentRootSet = new Set(currentRootIds);
      for (const session of this.sessions.values()) {
        if (!session.handshook) continue;
        if (!setsEqual(currentRootSet, session.lastRootSet)) {
          rootsChangedAnySession = true;
          break;
        }
      }
      if (!rootsChangedAnySession) return;
    }

    // Build the decoration payload once. Every session's delta carries
    // the same serialized snapshot — the per-session knownIds filter
    // only applies to tree entries, not decorations (SCM status is
    // observable across every window regardless of viewport).
    let decorationsJson: string | undefined;
    if (decorationChangedIds.length > 0) {
      const payload: Record<string, readonly DecorationOnWire[]> = {};
      for (const id of decorationChangedIds) {
        const merged = this.decorationStore.getMerged(id);
        payload[String(id)] = merged.map(toWireDecoration);
      }
      decorationsJson = JSON.stringify(payload);
    }

    // Freshest snapshot — used to lift ClientEntry records for any id
    // that moved (changed, added, or reparented) this tick.
    const snap = this.explorer.getSnapshot();

    // Phase B1 — the host's current root-id list, computed once per tick
    // and diffed per session below. The snapshot's `roots()` call is cheap
    // (native snapshot is a cached view) and we want every attached
    // session to see the same root picture on any given tick.
    const currentRootIds = snap.roots().map((e) => e.id);
    const currentRootSet = new Set(currentRootIds);

    for (const session of this.sessions.values()) {
      if (!session.handshook) continue;
      const view: SessionView = {
        expanded: session.expanded,
        knownIds: session.knownIds,
      };
      const delta = computeSessionDelta(cs, view);

      // Phase B1 — has the root set changed for this session since last
      // tick? Compare by id content (not reference). If so, we'll ship
      // the full current list on this delta; the client replaces its
      // `working.roots` verbatim. Also ensure every current root id is
      // in `knownIds` so the below changedIds/childSetChanged filter
      // doesn't silently drop the root Entry's ClientEntry payload —
      // root entries otherwise would be treated as "unknown to session"
      // and stay off the wire.
      const rootsChangedForSession = !setsEqual(currentRootSet, session.lastRootSet);
      if (rootsChangedForSession) {
        for (const id of currentRootIds) session.knownIds.add(id);
        session.lastRootSet = new Set(currentRootSet);
      }

      // Bundle the ClientEntry payloads for every id whose record
      // changed. Also sweep in children of `childSetChanged` parents
      // that the session doesn't know about — expanded folders get live
      // updates when their child list grows (SPEC §4.9.5).
      const outEntries: ClientEntry[] = [];
      const outDirectChildCounts: Record<string, number> = {};
      const emitted = new Set<number>();
      const removedIds: number[] = [];
      const liveChangedIds: number[] = [];
      for (const id of delta.changedIds) {
        if (emitted.has(id)) continue;
        const entry = snap.getById(id);
        if (!entry) {
          removedIds.push(id);
          session.knownIds.delete(id);
          continue;
        }
        liveChangedIds.push(id);
        outEntries.push(entryToClient(entry));
        emitted.add(id);
        const c = snap.directChildCount(id);
        if (c !== null) outDirectChildCounts[String(id)] = c;
      }
      const childSetChanged = new Set(delta.childSetChanged);
      for (const rootId of coarse) childSetChanged.add(rootId);
      const childLists = new Map<number, readonly number[]>();
      for (const parentId of childSetChanged) {
        const pc = snap.directChildCount(parentId);
        if (pc !== null) outDirectChildCounts[String(parentId)] = pc;
        if (!session.expanded.has(parentId)) continue;
        const kids = sortedChildIds(snap, parentId);
        childLists.set(parentId, kids);
      }

      // Phase B1 — also ensure any fresh root id's ClientEntry actually
      // rides this delta. The changedIds channel above only fires for
      // ids in the native ChangeSet; if a root was pre-existing in the
      // store (e.g. populated before this session handshook) but is
      // newly visible to *this* session because `roots` just started
      // shipping, emit its Entry record too so the client can look it
      // up via `byId` when resolving `roots`.
      if (rootsChangedForSession) {
        for (const id of currentRootIds) {
          if (emitted.has(id)) continue;
          const entry = snap.getById(id);
          if (!entry) continue;
          outEntries.push(entryToClient(entry));
          emitted.add(id);
          const c = snap.directChildCount(id);
          if (c !== null) outDirectChildCounts[String(id)] = c;
        }
      }

      const shouldRefreshViewport =
        !changeSetEmpty ||
        coarse.length > 0 ||
        subtreeDirty.length > 0 ||
        subtreeResynced.length > 0 ||
        rootsChangedForSession;
      const viewportPatch = shouldRefreshViewport ? this.collectViewportPatch(session, snap) : null;
      if (viewportPatch !== null) {
        for (const entry of viewportPatch.entries) {
          if (emitted.has(entry.id)) continue;
          outEntries.push(entry);
          emitted.add(entry.id);
        }
        Object.assign(outDirectChildCounts, viewportPatch.directChildCounts);
      }

      this.send(
        session,
        frame('delta', {
          version: delta.version,
          changedIds: liveChangedIds,
          ...(outEntries.length > 0 ? { viewportPatch: encodeClientEntries(outEntries) } : {}),
          childSetChanged: [...childSetChanged],
          ...(childLists.size > 0
            ? session.packedChildLists
              ? { childListsBin: encodeChildLists(childLists) }
              : { childLists: Object.fromEntries(childLists) }
            : {}),
          ...(viewportPatch !== null ? { viewportIds: viewportPatch.viewportIds } : {}),
          removedIds,
          directChildCounts: outDirectChildCounts,
          newVisibleCount: 0,
          coarseSubtrees: coarse,
          subtreeDirty,
          subtreeResynced,
          ...(decorationChangedIds.length > 0
            ? {
                decorationChangedIds,
                ...(decorationsJson !== undefined ? { decorationsJson } : {}),
              }
            : {}),
          ...(rootsChangedForSession ? { roots: [...currentRootIds] } : {}),
        }),
      );
    }
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
        this.handleHandshake(session, f.body as { options?: { prefetchRows?: number } });
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
        this.handleMutate(
          session,
          f.body as { reqId: number; op: string; args: Record<string, unknown> },
        );
        return;
      case 'call':
        void this.handleCall(session, f.body as { reqId: number; method: string; args: unknown[] });
        return;
      case 'dispose':
        this.detachSession(session.id);
        return;
      case 'decorations':
        this.handleDecorations(session, f.body as DecorationsFrameBody);
        return;
      default:
        this.sendError(session, 'EINVAL', `unknown message type: ${f.type}`);
    }
  }

  /**
   * Phase A1 — merge a client's decoration push into the shared
   * DecorationStore and schedule a fan-out. `replaceAll: true` wipes
   * the provider's slot first; otherwise we apply each `[id, deco]`
   * tuple as an upsert (non-null) or clear (null). Malformed bodies
   * produce a targeted `error` frame without disrupting other sessions.
   */
  private handleDecorations(session: Session, body: DecorationsFrameBody): void {
    if (
      typeof body.providerId !== 'string' ||
      body.providerId.length === 0 ||
      !Array.isArray(body.entries)
    ) {
      this.sendError(session, 'EINVAL', 'malformed decorations frame');
      return;
    }
    const providerId = body.providerId;
    const changed = new Set<number>();

    if (body.replaceAll === true) {
      const cleared = this.decorationStore.removeProvider(providerId);
      for (const id of cleared) changed.add(id);
    }

    for (const tuple of body.entries) {
      if (!Array.isArray(tuple) || tuple.length !== 2) continue;
      const rawTuple = tuple as unknown as readonly [unknown, unknown];
      const id = rawTuple[0];
      const deco = rawTuple[1];
      if (typeof id !== 'number' || !Number.isFinite(id)) continue;
      // deco may be null (clear) or a DecorationOnWire object.
      let d: Decoration | null;
      if (deco === null) {
        d = null;
      } else if (typeof deco === 'object' && deco !== null) {
        d = deco as Decoration;
      } else {
        continue;
      }
      const entryId: number = id;
      if (this.decorationStore.setForProvider(providerId, entryId, d)) {
        changed.add(entryId);
      }
    }

    if (changed.size === 0) return;
    // Bump the store version for consumers of the 'change:decorations'
    // channel on the host-local FileExplorer, then schedule a fan-out
    // tick so every session observes the change.
    this.decorationStore.bump([...changed]);
    for (const id of changed) this.pendingDecorationChangedIds.add(id);
    this.ensureTick();
  }

  private handleHandshake(
    session: Session,
    body: { options?: { prefetchRows?: number; packedChildLists?: boolean } },
  ): void {
    session.handshook = true;
    session.packedChildLists = body.options?.packedChildLists === true;
    const requestedPrefetch = body.options?.prefetchRows;
    session.prefetchRows =
      requestedPrefetch !== undefined && Number.isFinite(requestedPrefetch)
        ? Math.min(0xffff_ffff, Math.max(0, Math.trunc(requestedPrefetch)))
        : 100;
    const snap = this.explorer.getSnapshot();
    const roots = snap.roots().map((e) => e.id);
    const rootEntries = roots
      .map((id) => snap.getById(id))
      .filter((entry): entry is Entry => entry !== null)
      .map(entryToClient);
    const directChildCounts: Record<string, number> = {};
    for (const e of rootEntries) {
      const c = snap.directChildCount(e.id);
      if (c !== null) directChildCounts[String(e.id)] = c;
      session.knownIds.add(e.id);
    }
    // Phase B1 — seed lastRootSet with whatever we just shipped so the
    // per-tick delta builder only re-emits `roots` when the set
    // actually changes post-handshake (walker discovering a root, a
    // caller adding a root at runtime, etc.).
    session.lastRootSet = new Set(roots);
    this.send(
      session,
      frame('snapshot', {
        version: snap.treeVersion,
        roots,
        // Empty ArrayBuffers are omitted because Electron's utility↔renderer
        // structured clone may drop messages that contain them.
        ...(rootEntries.length > 0 ? { mirror: encodeClientEntries(rootEntries) } : {}),
        directChildCounts,
        visibleCount: rootEntries.length,
      }),
    );
  }

  private handleSetExpanded(session: Session, body: { add?: number[]; remove?: number[] }): void {
    for (const id of body.add ?? []) session.expanded.add(id);
    for (const id of body.remove ?? []) session.expanded.delete(id);

    // Headless clients may expand before publishing a viewport. Give that
    // first expansion a bounded useful window rather than returning only
    // structural placeholders; UI clients replace it with their exact range.
    if (session.viewport.limit === 0 && (body.add?.length ?? 0) > 0) {
      session.viewport = { offset: 0, limit: session.prefetchRows, overscan: 0 };
    }

    // Ship authoritative child ordering for each newly-expanded folder,
    // then hydrate only full entry records that intersect the viewport.
    // Newly-arrived children are covered by the same ordered-id plus
    // viewport-patch contract during normal delta fan-out.
    const snap = this.explorer.getSnapshot();

    // Phase B2 — auto-walk newly-expanded folders whose children aren't
    // in the store yet. Fires a depth-1 prefetch per id; delibrately
    // does NOT await — the walker publishes children via the ChangeSet
    // and the next tick's delta fan-out delivers them. We still ship
    // whatever's already in the snapshot below so the reply isn't empty
    // in the (common) case where the folder was already walked.
    //
    // Guard with `prefetched` to skip repeat walks and with `hasChildren`
    // so known-leaf folders don't trigger a pointless NAPI round-trip.
    for (const id of body.add ?? []) {
      if (this.prefetched.has(id)) continue;
      const kids = snap.childrenOf(id);
      if (kids.length > 0) {
        // Already walked; mark as covered to skip future expansions too.
        this.prefetched.add(id);
        continue;
      }
      // Check hasChildren — if the snapshot says this is a known leaf,
      // there's nothing to walk. The store returns `true` when the
      // directory has cached children; when the folder hasn't been
      // walked at all, it returns `false` (can't distinguish
      // "unknown-but-maybe-has-children" from "genuine leaf" without
      // doing the walk). Fire the walk regardless for now — depth-1
      // walks of empty / leaf folders are cheap.
      this.prefetched.add(id);
      try {
        void this.explorer.prefetch(id, { depth: 1 }).catch((e) => {
          // eslint-disable-next-line no-console
          console.warn(`[mille] setExpanded prefetch failed for id ${id}:`, e);
        });
      } catch (e) {
        // Synchronous throw (older native missing populateFromPath).
        // Fall back to the v0.1 behaviour — ship whatever's already in
        // the snapshot — and log once.
        // eslint-disable-next-line no-console
        console.warn(`[mille] setExpanded: prefetch not available for id ${id}; carrying on:`, e);
      }
    }

    const childLists = new Map<number, readonly number[]>();
    const newDirectChildCounts: Record<string, number> = {};
    const childSetIds: number[] = [];
    for (const id of body.add ?? []) {
      const kids = sortedChildIds(snap, id);
      const childCount = snap.directChildCount(id);
      if (kids.length > 0 || childCount === 0) {
        childSetIds.push(id);
        childLists.set(id, kids);
      }
      if (childCount !== null) newDirectChildCounts[String(id)] = childCount;
    }

    const viewportPatch = this.collectViewportPatch(session, snap);
    Object.assign(newDirectChildCounts, viewportPatch.directChildCounts);

    this.send(
      session,
      frame('delta', {
        version: this.explorer.getTreeVersion(),
        changedIds: [],
        ...(viewportPatch.entries.length > 0
          ? { viewportPatch: encodeClientEntries(viewportPatch.entries) }
          : {}),
        childSetChanged: childSetIds,
        ...(childLists.size > 0
          ? session.packedChildLists
            ? { childListsBin: encodeChildLists(childLists) }
            : { childLists: Object.fromEntries(childLists) }
          : {}),
        viewportIds: viewportPatch.viewportIds,
        removedIds: [],
        directChildCounts: newDirectChildCounts,
        newVisibleCount: snap.visibleRowCount(session.expanded).known,
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
    const normalize = (value: number): number =>
      Number.isFinite(value) ? Math.min(0xffff_ffff, Math.max(0, Math.trunc(value))) : 0;
    const offset = normalize(body.offset);
    const limit = normalize(body.limit);
    const overscan = normalize(body.overscan ?? 0);
    session.viewport = { offset, limit, overscan };

    const snap = this.explorer.getSnapshot();
    const viewportPatch = this.collectViewportPatch(session, snap);

    this.send(
      session,
      frame('delta', {
        version: snap.treeVersion,
        changedIds: [],
        ...(viewportPatch.entries.length > 0
          ? { viewportPatch: encodeClientEntries(viewportPatch.entries) }
          : {}),
        viewportIds: viewportPatch.viewportIds,
        childSetChanged: [],
        removedIds: [],
        directChildCounts: viewportPatch.directChildCounts,
        newVisibleCount: snap.visibleRowCount(session.expanded).known,
        coarseSubtrees: [],
        subtreeDirty: [],
        subtreeResynced: [],
      }),
    );
  }

  private collectViewportPatch(
    session: Session,
    snap: MirrorSnapshot,
  ): {
    entries: ClientEntry[];
    directChildCounts: Record<string, number>;
    viewportIds: number[];
  } {
    const { offset, limit, overscan } = session.viewport;
    const before = Math.min(offset, overscan);
    const viewportOffset = offset - before;
    const viewportLimit = Math.min(0xffff_ffff, limit + before + overscan);
    const rows = snap.visibleRows({
      expanded: session.expanded,
      offset: viewportOffset,
      limit: viewportLimit,
    });
    const entries: ClientEntry[] = [];
    const directChildCounts: Record<string, number> = {};
    const viewportIds: number[] = [];
    for (const row of rows) {
      const entry = snap.getById(row.id);
      if (!entry) continue;
      viewportIds.push(entry.id);
      session.knownIds.add(entry.id);
      if (session.viewportIds.has(entry.id)) continue;
      entries.push(entryToClient(entry));
      const childCount = snap.directChildCount(entry.id);
      if (childCount !== null) directChildCounts[String(entry.id)] = childCount;
    }
    session.viewportIds = new Set(viewportIds);
    return { entries, directChildCounts, viewportIds };
  }

  private handleMutate(
    session: Session,
    body: { reqId: number; op: string; args: Record<string, unknown> },
  ): void {
    // SPEC §5.1 ordering: serialize every mutation on a single promise
    // chain. Inside the chain entry we
    //   1. dispatch the op against the local FileExplorer
    //   2. flush a delta to every session synchronously (before step 3)
    //   3. THEN post mutateResult back to the initiator
    // so a remote session observes the state change before the
    // initiator's own resolve — windows never disagree about "did that
    // rename happen yet?".
    //
    // The outer .catch() is essential: without it, a rejection inside
    // the entry would poison the chain and block every subsequent
    // mutation forever. We swallow (log) chain-level rejections but
    // keep the next mutation unblocked.
    this.mutationQueue = this.mutationQueue
      .then(async () => {
        try {
          const result = await this.dispatchMutation(body.op, body.args);
          // Fan out first, reply second.
          await this.flushTickNow();
          this.send(session, frame('mutateResult', { reqId: body.reqId, result }));
        } catch (e: unknown) {
          const err = toErrorPayload(e);
          // Still flush a delta: partial state (e.g. a rename that
          // created the target before failing on the source) may have
          // landed and other sessions need to see it.
          await this.flushTickNow();
          this.send(
            session,
            frame('mutateResult', { reqId: body.reqId, result: null, error: err }),
          );
        }
      })
      .catch((e: unknown) => {
        // Queue-level failure (e.g. flushTickNow threw). Don't let it
        // poison the chain for subsequent mutations from any session.
        // eslint-disable-next-line no-console
        console.error('[mille] mutation queue error:', e);
      });
  }

  /**
   * Immediate, out-of-band delta flush. Used by the mutation queue so
   * fan-out happens synchronously with the op rather than waiting for
   * the next 16ms tick boundary. A microtask yield after `tick()` lets
   * queued `postMessage` calls land before we reply to the initiator.
   */
  private async flushTickNow(): Promise<void> {
    this.tick();
    await new Promise<void>((resolve) => {
      // setImmediate is preferable to setTimeout(0) — it fires after
      // the current I/O phase, which is when MessagePort-postMessage
      // actually drops the message onto the peer's queue.
      setImmediate(resolve);
    });
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
        return this.explorer.readText(args.id as EntryId, args.encoding as string | undefined);
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
      const result = await this.dispatchCall(session, body.method, body.args);
      this.send(session, frame('callResult', { reqId: body.reqId, result }));
    } catch (e: unknown) {
      const err = toErrorPayload(e);
      this.send(session, frame('callResult', { reqId: body.reqId, result: null, error: err }));
    }
  }

  private async dispatchCall(session: Session, method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'getTreeVersion':
        return this.explorer.getTreeVersion();
      case 'capabilities':
        return this.explorer.capabilities;
      case 'resolvePath': {
        const path = args[0];
        if (typeof path !== 'string') throw new Error('resolvePath requires a string path');
        const id = await this.explorer.resolvePath(path);
        if (id === null) return null;

        // Return only the target-to-root records. This makes lazy path reveal
        // immediately usable by the renderer without shipping a full tree or
        // pretending that a partial path is an authoritative child listing.
        const snapshot = this.explorer.getSnapshot();
        const entries: ClientEntry[] = [];
        let cursor: EntryId | null = id;
        let guard = 0;
        while (cursor !== null && guard < 10_000) {
          const entry = snapshot.getById(cursor);
          if (entry === null) break;
          entries.push(entryToClient(entry));
          session.knownIds.add(cursor);
          cursor = entry.parentId ?? null;
          guard += 1;
        }
        return { id, version: snapshot.treeVersion, entries };
      }
      case 'findVisiblePrefix': {
        const [prefix, fromId, skipCurrent, expanded] = args;
        if (typeof prefix !== 'string') throw new Error('findVisiblePrefix requires a prefix');
        if (fromId !== null && typeof fromId !== 'number') {
          throw new Error('findVisiblePrefix requires a numeric or null fromId');
        }
        if (typeof skipCurrent !== 'boolean' || !Array.isArray(expanded)) {
          throw new Error('findVisiblePrefix requires skipCurrent and expanded');
        }
        const id = this.explorer
          .getSnapshot()
          .visiblePrefixMatch(prefix, fromId, skipCurrent, new Set(expanded as EntryId[]));
        if (id === null) return null;
        const snapshot = this.explorer.getSnapshot();
        const entries: ClientEntry[] = [];
        let cursor: EntryId | null = id;
        let guard = 0;
        while (cursor !== null && guard < 10_000) {
          const entry = snapshot.getById(cursor);
          if (entry === null) break;
          entries.push(entryToClient(entry));
          session.knownIds.add(cursor);
          cursor = entry.parentId ?? null;
          guard += 1;
        }
        return { id, version: snapshot.treeVersion, entries };
      }
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
    if (this.sessions.size === 0) this.stopTick();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.watcherEventSub.dispose();
    this.stopTick();
    for (const id of [...this.sessions.keys()]) {
      this.detachSession(id);
    }
    await this.explorer.dispose();
  }
}

/**
 * Phase B1 — content equality for two number sets. Fast path when sizes
 * differ; otherwise one-pass `.has` check. Used by the per-session
 * delta builder to decide whether to re-ship `roots`.
 */
function setsEqual(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

/**
 * Project an in-memory `Decoration` into its wire shape. Keeps the
 * same key set; spread-only-when-defined satisfies
 * `exactOptionalPropertyTypes`.
 */
function toWireDecoration(d: Decoration): DecorationOnWire {
  const out: { -readonly [K in keyof DecorationOnWire]: DecorationOnWire[K] } = {};
  if (d.badge !== undefined) out.badge = d.badge;
  if (d.color !== undefined) out.color = d.color;
  if (d.tooltip !== undefined) out.tooltip = d.tooltip;
  if (d.propagate !== undefined) out.propagate = d.propagate;
  return out;
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
export async function createFileExplorerHost(options: ExplorerOptions): Promise<FileExplorerHost> {
  return new FileExplorerHostImpl(options);
}

export type { FileExplorerHost, MessagePortLike } from './types.js';
