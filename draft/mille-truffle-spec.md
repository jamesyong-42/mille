Mille Remote Workspace over Truffle

Implementation-Ready Specification

• Status: Proposed
• Spec version: 1.0
• Date: July 25, 2026
• Target repositories: vibecook-dev/mille, vibecook-dev/truffle
• Primary transport: Truffle TCP over Tailscale

> This document is normative for the Phase 1 implementation unless a section is explicitly marked Future Work or Non-Normative.

Contents

• 
  1. Executive decision
• 
  2. Scope and normative language
• 
  3. Current architecture baseline
• 
  4. Goals, non-goals, and success criteria
• 
  5. Terminology
• 
  6. Requirements
• 
  7. Target architecture
• 
  8. Package and module boundaries
• 
  9. Core channel abstraction
• 
  10. MessagePort compatibility adapter
• 
  11. Framed stream wire protocol
• 
  12. Host and client refactor
• 
  13. Remote workspace service protocol
• 
  14. Truffle integration API
• 
  15. Export and workspace lifecycle
• 
  16. Authorization and operation policy
• 
  17. Security model
• 
  18. Connection, disconnect, and reconnect behavior
• 
  19. Errors and diagnostics
• 
  20. Backpressure, limits, and performance
• 
  21. Observability
• 
  22. Compatibility and versioning
• 
  23. File-by-file implementation plan
• 
  24. Test plan
• 
  25. Acceptance criteria
• 
  26. Delivery plan and PR sequence
• 
  27. Risks, mitigations, and deferred work
• Appendix A. Complete public API sketch
• Appendix B. Wire examples
• Appendix C. Tailscale policy example
• Appendix D. Source baseline

> **Reading guide:** Sections 9 through 18 are the normative implementation contract. Sections 23 through 26 translate that contract into concrete code changes, tests, and pull requests.

1. Executive decision

Mille shall support remote workspaces by running its existing native explorer host on the computer that owns the files and carrying the existing host/client mirror protocol over a transport-neutral channel. The first network transport shall be a Truffle TCP stream routed through Tailscale.

> **Core decision:** Truffle is an ExplorerChannel transport. It is not a low-level FileSystemProvider for individual stat, readDirectory, watch, or search calls.

```text
Computer A: client / UI                  Computer B: file owner

FileTree / app UI                        @vibecook/mille-truffle server
        |                                            |
RemoteFileExplorer facade                           FileExplorerHost
        |                                            |
PortFileExplorer + local mirror                     Native FileExplorer
        |                                            |
FramedStreamExplorerChannel                         Real local filesystem
        |                                            |
TruffleSocket  ===== Tailscale encrypted link ===== TruffleSocket
```

This design preserves Mille’s native Rust walker, watcher, search pipeline, ignore semantics, canonical EntryStore, delta coalescing, viewport projection, and local client mirror. Network access adds one ordered stream between the existing host and client roles instead of introducing per-file network RPC.

Phase 1 uses mesh.net because Mille’s current protocol is a single reliable, ordered control stream. QUIC multiplexing is deferred until large content reads and writes require independent flow-control domains.

2. Scope and normative language

The terms MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative. “Phase 1” means the first production-capable release described by this specification. Sections explicitly marked Future Work are non-normative.

2.1 In scope

• A transport-neutral channel abstraction in @vibecook/mille.
• Backward-compatible MessagePort host/client APIs.
• A versioned framed byte-stream codec for Node Duplex streams.
• A Truffle TCP server and client package.
• Named, preconfigured workspace exports rather than arbitrary client paths.
• Read-only and read-write session policy enforcement.
• Peer authorization using verified Truffle/Tailscale identity.
• Frozen-mirror offline behavior and reconnect by fresh snapshot.
• Tests, benchmarks, migration steps, and acceptance criteria.

2.2 Out of scope for Phase 1

• Implementing SSH, SFTP, WebDAV, object-storage, or cloud providers.
• Making the Rust Fs trait asynchronous or network-aware.
• Offline mutation queues or conflict resolution.
• Resumable delta replay across server restart.
• QUIC content-stream multiplexing.
• Remote arbitrary-root mounting supplied by the client.
• Cross-export atomic move.
• A browser-only Truffle client.

3. Current architecture baseline

This specification is based on the Mille and Truffle repositories as inspected on July 25, 2026. The baseline is important because the design intentionally preserves the existing ownership boundaries rather than replacing them.

3.1 Mille baseline

|Area             |Current shape                                                                                                            |Implication                                                              |
|-----------------|-------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------|
|Host             |`FileExplorerHostImpl` owns a concrete native `FileExplorer` and a map of per-port sessions.                             |Refactor session transport, not the explorer engine.                     |
|Client           |`PortFileExplorer` consumes structured-cloned frames and maintains a lightweight mirror.                                 |The same mirror can consume decoded network frames.                      |
|Protocol         |`PROTOCOL_VERSION = 1`; semantic frames already separate snapshot, delta, call, mutation, ack, warning, and error.       |Keep semantic messages; add explicit stream framing below them.          |
|Binary data      |Snapshots and deltas already carry `ArrayBuffer` payloads; file reads/writes currently use number arrays at one API edge.|The stream codec must preserve binary attachments without JSON expansion.|
|Sessions         |Expansion, viewport, known IDs, and acknowledgement state are per connection.                                            |Remote connections map naturally to existing sessions.                   |
|Provider boundary|URI/provider abstractions exist alongside the optimized native pipeline.                                                 |Do not route the primary Truffle integration through provider-level RPC. |
|Identity         |`EntryId` is session/process scoped and may be reassigned after a new engine boot.                                       |Reconnect must detect workspace-instance replacement.                    |

3.2 Truffle baseline

|Capability    |Current shape                                                                |Use in this design                                                               |
|--------------|-----------------------------------------------------------------------------|---------------------------------------------------------------------------------|
|TCP           |`TruffleSocket` is a Node `Duplex`; servers accept verified peer identity.   |Primary Phase 1 carrier.                                                         |
|Peer identity |Accepted sockets expose stable remote peer ID and peer name.                 |Application authorization and audit identity.                                    |
|Tailscale     |Provides encrypted tunnels, device identity, routing, and policy enforcement.|Network security and reachability layer.                                         |
|QUIC          |Multiple reliable, ordered, independently flow-controlled streams.           |Future large-content transport.                                                  |
|Mesh ownership|A caller creates and owns the `MeshNode` and app identity.                   |Mille integration must accept an existing node; it must not create a second node.|

4. Goals, non-goals, and success criteria

4.1 Product goals

• Browse, expand, search, watch, read, and mutate a workspace on another tailnet device with the same high-level Mille API used locally.
• Preserve native traversal and watch performance by executing filesystem work beside the files.
• Keep the UI responsive through Mille’s existing local mirror and viewport projection.
• Make remote access optional: base Mille must not depend on Truffle.
• Make authorization explicit and default-deny for privileged/global operations.
• Treat sleep, route changes, and temporary disconnection as expected states.

4.2 Engineering success criteria

• All existing MessagePort tests and public APIs remain compatible.
• No filesystem operation is implemented as one network round trip per directory entry.
• A remote host can serve multiple clients while retaining one native walker/watcher per exported workspace.
• Untrusted clients cannot escape configured roots, mutate a read-only export, cancel another session’s operation, or alter host-global workspace configuration.
• Receive and send queues are bounded; malformed frames close the connection deterministically.
• Disconnect rejects pending operations, leaves the last immutable snapshot readable, and reconnects without replaying writes.
• The implementation includes CI-capable stream tests and a manual two-device tailnet acceptance procedure.

5. Terminology

|Term                |Definition                                                                                                               |
|--------------------|-------------------------------------------------------------------------------------------------------------------------|
|Explorer engine     |The native Mille object that owns canonical filesystem state, walking, watching, search, and mutation execution.         |
|Explorer host       |The server-side Mille object that exposes an explorer engine to one or more sessions.                                    |
|Explorer client     |The client-side mirror and RPC facade currently represented by `PortFileExplorer`.                                       |
|Explorer channel    |An ordered, reliable, message-oriented interface connecting one host session and one client.                             |
|Stream channel      |An ExplorerChannel implemented over a byte-oriented Node `Duplex` with explicit framing.                                 |
|Remote service      |The Truffle-facing listener that authenticates a peer, resolves an export, and attaches the stream to a FileExplorerHost.|
|Export              |A server-defined, named workspace configuration containing roots, access level, and explorer options.                    |
|Workspace instance  |One live host/engine instance for an export, identified by a generated `workspaceInstanceId`.                            |
|Session             |One accepted client connection with independent expansion, viewport, known IDs, acknowledgement state, and permissions.  |
|Effective capability|A capability visible to a session after combining native engine capabilities with export/session policy.                 |

6. Requirements

6.1 Functional requirements

• FR-001 — The host and client MUST communicate through an ExplorerChannel abstraction that is independent of MessagePort and Truffle.
• FR-002 — Existing attachPort() and connectFileExplorer() APIs MUST remain and MUST internally use a MessagePort channel adapter.
• FR-003 — The stream channel MUST preserve semantic message order and binary payloads.
• FR-004 — The Truffle server MUST run the native Mille explorer on the device that owns the files.
• FR-005 — A client MUST open a named export; it MUST NOT supply arbitrary absolute roots.
• FR-006 — A remote session MUST support the existing tree snapshot, delta, expansion, viewport, call, mutation, acknowledgement, warning, and error flows.
• FR-007 — A remote client MUST expose connection state and MUST keep the last frozen snapshot available while stale.
• FR-008 — Reconnect MUST request a fresh snapshot in Phase 1 and MUST NOT replay queued mutations.
• FR-009 — The server MUST support multiple sessions per export and SHOULD reuse one host per export.
• FR-010 — The server MUST expose verified remote peer identity to authorization and logging hooks.
• FR-011 — Read-only policy MUST be enforced on the server regardless of client UI state.
• FR-012 — Large file-content streaming MAY be rejected above the configured Phase 1 control-stream limit.

6.2 Non-functional requirements

• NFR-001 — No unbounded buffer, queue, pending-request map, operation map, or reconnect loop is permitted.
• NFR-002 — MessagePort-local performance SHOULD regress by less than 5% at median and p95 in existing benchmarks.
• NFR-003 — The codec MUST handle arbitrary stream fragmentation and frame coalescing.
• NFR-004 — The stream transport MUST apply Node write backpressure and expose a drain primitive.
• NFR-005 — A single malformed frame MUST terminate only that session, not the shared workspace host.
• NFR-006 — Logging MUST avoid file content and MUST redact absolute paths by default outside debug mode.
• NFR-007 — The public API MUST remain tree-shakeable and MUST not import Node-only modules from browser-safe entry points.
• NFR-008 — The remote package MUST accept a caller-owned Truffle MeshNode and MUST NOT create or own a separate mesh identity.

6.3 Security requirements

• SEC-001 — Authorization MUST occur before attaching a socket to a FileExplorerHost.
• SEC-002 — Every export root MUST be absolute, canonicalized at startup, and inaccessible through traversal or alternate path spelling.
• SEC-003 — Phase 1 remote exports MUST use followSymlinks: false.
• SEC-004 — copyFromPath, workspace-root mutation, projection mutation, undo, workspace-wide resync, and client-provided decorations MUST be denied by default for remote sessions.
• SEC-005 — Operation cancellation and operation-progress messages MUST be scoped to the session that owns the operation.
• SEC-006 — Unknown export and unauthorized export responses SHOULD be externally indistinguishable unless an administrator enables diagnostic disclosure.
• SEC-007 — Tailscale policy SHOULD restrict the Mille service port to intended users/devices in addition to application-level authorization.

7. Target architecture

7.1 Component view

```text
@vibecook/mille (transport-independent)

  FileExplorerHostImpl
       | attachChannel(ExplorerHostChannel, SessionContext)
       +-------------------------+
                                 |
                         ExplorerChannel
                         /              \
       MessagePortExplorerChannel    FramedStreamExplorerChannel
          local Electron/Worker         Node Duplex / TruffleSocket

@vibecook/mille-truffle (optional integration)

  serveMille(mesh, exports, authorize)     connectMille(mesh, peer, export)
               |                                      |
        mesh.net.createServer                       mesh.net.connect
               |                                      |
        TruffleSocket <========== Tailscale =========> TruffleSocket
```

7.2 Connection sequence

```text
Client                     Truffle/Tailscale             Server
  | mesh.net.connect()              |                      |
  |-------------------------------->|--------------------->|
  |                                 |     accept socket     |
  |-------- Remote Open request -------------------------->|
  |                                   validate frame/version
  |                                   resolve export
  |                                   authorize peer
  |                                   obtain/reuse host
  |<------- Remote Accepted + limits + instance ID --------|
  |-------- Existing Mille handshake --------------------->|
  |<------- Existing Mille handshake/snapshot -------------|
  |-------- setExpanded / setViewport / calls ------------>|
  |<------- delta / viewport patch / results --------------|
```

7.3 Layer ownership

|Layer                |Owns                                                                                            |Must not own                                            |
|---------------------|------------------------------------------------------------------------------------------------|--------------------------------------------------------|
|Mille native engine  |Files, canonical tree, walker, watcher, native search, mutations.                               |Network identity, Tailscale policy, reconnect loop.     |
|FileExplorerHost     |Session projection, expansion, viewport, protocol dispatch, policy checks.                      |Truffle socket construction or export discovery.        |
|ExplorerChannel      |Ordered message delivery, close notification, buffering semantics.                              |Filesystem authorization or remote export selection.    |
|Framed stream codec  |Bytes-to-messages framing, binary attachments, bounds validation.                               |Mille business logic or Truffle peer policy.            |
|Mille Truffle service|Listen/connect, open handshake, export lookup, peer authorization, host cache, reconnect facade.|Native walking logic or Tailscale tunnel implementation.|
|Tailscale/Truffle    |Encrypted connectivity, verified device identity, routing, port reachability.                   |Filesystem root permissions inside Mille.               |

8. Package and module boundaries

8.1 @vibecook/mille

The base package remains usable with no Truffle dependency. It adds a channel abstraction and a Node-only framed stream entry point.

```text
packages/mille/src/
  channel/
    types.ts                 ExplorerChannel contracts
    message-port.ts          MessagePort adapter
    emitter.ts               small channel event helper
  stream/
    framed-channel.ts        Node Duplex channel implementation
    codec.ts                 encode/decode semantic frames
    decoder.ts               incremental frame parser
    limits.ts                defaults and validation
  host.ts                    attachChannel + session policy
  client-port.ts             connectFileExplorerChannel + close handling
  protocol.ts                existing semantic protocol (mostly unchanged)
  index.ts                   browser-safe exports
  node.ts                    Node-only framed stream exports
```

8.2 @vibecook/mille-truffle

The integration SHOULD live as a sibling package in the Mille monorepo unless the maintainer prefers a standalone repository. It depends on @vibecook/mille and Truffle, and exports no native filesystem implementation of its own.

```text
packages/mille-truffle/src/
  server.ts                  serveMille(), listener, session registry
  client.ts                  connectMille(), reconnect facade
  handshake.ts               remote-open messages and validator
  exports.ts                 export normalization and host cache keys
  authorize.ts               policy composition
  state.ts                   connection state machine
  errors.ts                  RemoteExplorerError
  types.ts                   public interfaces
  index.ts                   public exports
```

8.3 Dependency direction

```text
@vibecook/mille-truffle  --->  @vibecook/mille/node
             |
             +------------->  @vibecook/truffle (or current Truffle package)

@vibecook/mille  -X->  Truffle
@vibecook/mille  -X->  Tailscale
```

> **Rule:** No import from Truffle may appear in the base Mille package. The generic framed channel must work with any Node Duplex, including PassThrough, sockets, pipes, SSH stdio, or a future QUIC stream.

9. Core channel abstraction

9.1 Public contract

```ts
export type ExplorerChannelState = 'open' | 'closing' | 'closed';

export type ExplorerChannelCloseCode =
  | 'LOCAL_CLOSE'
  | 'REMOTE_CLOSE'
  | 'TRANSPORT_ERROR'
  | 'PROTOCOL_ERROR'
  | 'BACKPRESSURE'
  | 'AUTH_REJECTED';

export interface ExplorerChannelCloseEvent {
  readonly code: ExplorerChannelCloseCode;
  readonly reason?: string;
  readonly cause?: unknown;
}

export interface ExplorerChannel<TOutbound, TInbound>
  extends Disposable {
  readonly state: ExplorerChannelState;

  /** Bytes queued by this adapter but not yet accepted by the transport. */
  readonly bufferedBytes: number;

  /**
   * Queues one ordered message.
   * Throws synchronously if closed or if the hard queue limit is exceeded.
   */
  send(message: TOutbound): void;

  /** Resolves after all messages queued before this call have drained. */
  drain(): Promise<void>;

  onMessage(listener: (message: TInbound) => void): Disposable;
  onClose(listener: (event: ExplorerChannelCloseEvent) => void): Disposable;

  /** Idempotent. Emits exactly one close event locally. */
  close(reason?: string): void;
}

export type ExplorerHostChannel = ExplorerChannel<
  HostToClientMessage,
  ClientToHostMessage
>;

export type ExplorerClientChannel = ExplorerChannel<
  ClientToHostMessage,
  HostToClientMessage
>;
```

9.2 Required semantics

• CH-001 — Messages observed by the receiver MUST preserve the sender’s send() order.
• CH-002 — send() confirms local enqueue only. It does not confirm remote receipt or application; existing Mille ack/result messages retain that role.
• CH-003 — send() MUST throw when the channel is not open or when accepting the message would exceed the hard outbound queue limit.
• CH-004 — drain() MUST resolve only after bytes corresponding to all previously queued messages have been accepted by the underlying transport.
• CH-005 — onClose MUST fire exactly once. All later transport errors are logged but do not emit duplicate close events.
• CH-006 — A channel implementation MUST stop delivering messages after close.
• CH-007 — Listener disposal MUST be idempotent.
• CH-008 — Channel code MUST not catch and hide listener exceptions; it SHOULD report them through the package logger while preserving channel liveness.

9.3 Internal state machine

```text
            send / receive
       +---------------------+
       |                     v
     OPEN  -- close() -->  CLOSING  -- transport ended --> CLOSED
       |                       |
       +-- error / violation --+

CLOSED is terminal. Close notification is emitted once on the first transition
away from OPEN, with the most specific available close code.
```

10. MessagePort compatibility adapter

10.1 Factory API

```ts
export function createMessagePortHostChannel(
  port: MessagePortLike,
): ExplorerHostChannel;

export function createMessagePortClientChannel(
  port: MessagePortLike,
): ExplorerClientChannel;
```

10.2 Compatibility wrappers

```ts
export interface FileExplorerHost extends Disposable {
  attachChannel(
    channel: ExplorerHostChannel,
    context?: ExplorerSessionContext,
  ): Disposable;

  /** Backward-compatible wrapper with local-admin policy. */
  attachPort(port: MessagePortLike): Disposable;
}

export function connectFileExplorerChannel(
  channel: ExplorerClientChannel,
  options?: PortFileExplorerOptions,
): PortFileExplorer;

/** Backward-compatible wrapper. */
export function connectFileExplorer(
  port: MessagePortLike,
  options?: PortFileExplorerOptions,
): PortFileExplorer;
```

attachPort() MUST construct a MessagePort host channel and apply the current local behavior, including admin-equivalent permissions. connectFileExplorer() MUST construct the corresponding client channel. Existing application code therefore requires no migration.

10.3 Transfer-list behavior

The MessagePort adapter SHOULD retain the current transferable-ArrayBuffer fast path. The generic channel contract intentionally does not expose a transfer list. The adapter may inspect the semantic message and transfer buffers when doing so is safe; other channel implementations encode them as binary attachments.

11. Framed stream wire protocol

11.1 Scope

The stream wire protocol converts one existing semantic Mille message into one bounded frame on a reliable ordered byte stream. It is independent from the remote-workspace open handshake and independent from Truffle.

11.2 Wire constants

|Constant           |Phase 1 value|Meaning                                                             |
|-------------------|-------------|--------------------------------------------------------------------|
|Magic              |ASCII `MLLE` |Reject accidental or cross-protocol traffic.                        |
|Wire major         |`1`          |Breaking frame-format version.                                      |
|Wire minor         |`0`          |Backward-compatible frame additions.                                |
|Byte order         |Big endian   |All fixed-width integers.                                           |
|Compression        |Disabled     |Flag reserved; receiving an unknown active flag is a protocol error.|
|Metadata encoding  |UTF-8 JSON   |Semantic object with binary placeholders.                           |
|Attachment encoding|Raw bytes    |ArrayBuffer, Buffer, DataView, and typed-array slices.              |

11.3 Frame layout

```text
Offset  Size  Field
0       4     magic = 0x4D 0x4C 0x4C 0x45  ("MLLE")
4       1     wireMajor
5       1     wireMinor
6       2     flags (u16)
8       4     metadataLength (u32)
12      4     attachmentCount (u32)
16      4     attachmentBytes (u32)
20      N     metadata UTF-8 JSON
20+N    4*A   attachment-length table, A unsigned u32 values
...     B     concatenated attachment bytes
```

Total frame length is 20 + metadataLength + attachmentCount * 4 + attachmentBytes. A decoder MUST validate this total using overflow-safe arithmetic before allocating or waiting for the full frame.

11.4 Binary placeholder

```json
interface BinaryPlaceholder {
  readonly $mille: 'bin';
  readonly i: number;
}

// Example metadata fragment:
{
  "v": 1,
  "type": "snapshot",
  "body": {
    "mirror": { "$mille": "bin", "i": 0 },
    "viewportPatch": { "$mille": "bin", "i": 1 }
  }
}
```

The encoder walks the semantic message, replaces binary views with placeholders, and appends exactly the referenced byte ranges as attachments. The decoder reconstructs Uint8Array values. It MUST reject cyclic objects, duplicate placeholder mutation, invalid attachment indexes, SharedArrayBuffer, and unsupported prototype-bearing values.

11.5 Typed-array byte-range rule

For Uint8Array, Buffer, DataView, and all typed arrays, the encoder MUST preserve the view’s byteOffset and byteLength; it MUST NOT serialize the entire backing buffer. On decode, all binary placeholders become fresh Uint8Array instances containing only the encoded bytes.

11.6 Default limits

|Limit                         |Default|Configurable                      |Failure                             |
|------------------------------|-------|----------------------------------|------------------------------------|
|Metadata bytes                |4 MiB  |Yes, lower only from remote policy|PROTOCOL_ERROR                      |
|Attachment count              |32     |Yes, lower only                   |PROTOCOL_ERROR                      |
|Total frame bytes             |32 MiB |Yes, negotiated lower value       |PROTOCOL_ERROR / EFBIG              |
|File payload on control stream|16 MiB |Per export                        |`EFBIG` before send                 |
|Outbound soft watermark       |8 MiB  |Yes                               |Caller may await `drain()`          |
|Outbound hard limit           |32 MiB |Yes                               |Synchronous BACKPRESSURE close/error|
|Incremental receive buffer    |40 MiB |Derived from max frame            |PROTOCOL_ERROR                      |

11.7 Incremental decoder algorithm

• Append each received byte chunk to a bounded segmented buffer.
• Do not allocate a frame payload until at least the 20-byte header is available and validated.
• Validate magic, major version, flags, counts, lengths, and total size.
• Wait until the full frame is available; the stream may split at any byte.
• Parse metadata as UTF-8 JSON; reject invalid UTF-8 or JSON.
• Read the attachment length table and verify that its sum equals attachmentBytes.
• Reconstruct binary placeholders and emit exactly one semantic message.
• Continue parsing because one stream chunk may contain multiple complete frames.

11.8 Node Duplex factory

```ts
export interface FramedStreamChannelOptions {
  readonly maxMetadataBytes?: number;       // default 4 MiB
  readonly maxAttachments?: number;         // default 32
  readonly maxFrameBytes?: number;          // default 32 MiB
  readonly outboundSoftBytes?: number;      // default 8 MiB
  readonly outboundHardBytes?: number;      // default 32 MiB
  readonly logger?: ExplorerChannelLogger;
}

export function createFramedStreamHostChannel(
  stream: Duplex,
  options?: FramedStreamChannelOptions,
): ExplorerHostChannel;

export function createFramedStreamClientChannel(
  stream: Duplex,
  options?: FramedStreamChannelOptions,
): ExplorerClientChannel;
```

> **Node entry point:** These factories MUST be exported from `@vibecook/mille/node`, not the browser-safe root entry, so bundlers do not pull `node:stream` into renderer or browser builds.

12. Host and client refactor

12.1 Session context and policy

```ts
export type ExplorerSessionAccess =
  | 'admin'
  | 'read-write'
  | 'read-only';

export interface ExplorerSessionPolicy {
  readonly access: ExplorerSessionAccess;
  readonly allowClientDecorations?: boolean;
  readonly allowProjectionMutation?: boolean;
  readonly allowWorkspaceRootMutation?: boolean;
  readonly allowExternalImport?: boolean;
  readonly allowUndo?: boolean;
  readonly allowWorkspaceResync?: boolean;
}

export interface ExplorerSessionContext {
  readonly kind?: 'local' | 'remote';
  readonly clientId?: string;
  readonly peerId?: string;
  readonly peerName?: string;
  readonly exportId?: string;
  readonly policy?: ExplorerSessionPolicy;
}
```

Absent context on attachChannel() defaults to local-admin behavior only for in-process compatibility. The Truffle integration MUST always provide an explicit remote context and policy.

12.2 Session storage change

```ts
interface Session {
  readonly id: number;
  readonly channel: ExplorerHostChannel;
  readonly context: RequiredSessionContext;
  readonly expanded: Set<EntryId>;
  readonly knownIds: Set<EntryId>;
  readonly ownedOperationIds: Set<string>;
  viewport?: ViewportRequest;
  ackRequested: boolean;
  disposed: boolean;
}
```

Every direct use of session.port.postMessage in the host MUST become session.channel.send. Port lifecycle listeners become channel close listeners. A channel close disposes only that session and does not dispose the shared host.

12.3 Permission enforcement point

Policy MUST be checked in the host before native dispatch. The Truffle package may pre-check for better errors, but host-side checks are authoritative. This prevents future transports or accidentally permissive clients from bypassing policy.

12.4 Effective capabilities

Any capabilities returned to a session MUST be masked by session policy. A read-only session sees read capabilities plus Readonly; write, trash, and atomic-write capabilities are removed. The shared snapshot does not need per-session isReadonly row mutation; consumers use the effective capabilities to disable UI, while the server still rejects forbidden operations.

12.5 Binary file payload cleanup

• readFile results SHOULD return Uint8Array directly instead of converting to number[].
• writeFile requests SHOULD send Uint8Array directly instead of Array.from(data).
• The client MUST accept both Uint8Array and legacy number-array read results for compatibility.
• The host MUST accept both forms for compatibility.
• The control-stream file-size policy is checked before allocating or enqueueing the frame.

12.6 Client close behavior

PortFileExplorer MUST subscribe to channel close. On close it rejects all pending calls and mutations with one RemoteExplorerError or transport-neutral connection error, clears pending timers, marks itself closed, and emits a connection event. It MUST continue to return the last immutable mirror snapshot until disposed.

```ts
export interface ExplorerConnectionEvent {
  readonly state: 'online' | 'closed';
  readonly reason?: ExplorerChannelCloseEvent;
}

// Add to PortFileExplorer event map:
connection: ExplorerConnectionEvent;
```

13. Remote workspace service protocol

13.1 Layering

The remote-service open handshake runs as the first semantic messages on the framed stream. Only after acceptance does the client send the existing Mille protocol handshake. This keeps workspace selection and authorization outside the base explorer protocol.

13.2 Request

```ts
export interface OpenWorkspaceRequest {
  readonly service: 'mille.remote';
  readonly version: 1;
  readonly type: 'open';
  readonly requestId: string;
  readonly exportId: string;
  readonly requestedAccess: 'read-only' | 'read-write';
  readonly client: {
    readonly instanceId: string;
    readonly name?: string;
    readonly milleVersion: string;
    readonly milleTruffleVersion: string;
  };
}
```

13.3 Acceptance response

```ts
export interface OpenWorkspaceAccepted {
  readonly service: 'mille.remote';
  readonly version: 1;
  readonly type: 'accepted';
  readonly requestId: string;
  readonly sessionId: string;
  readonly workspaceInstanceId: string;
  readonly export: {
    readonly id: string;
    readonly label: string;
    readonly access: 'read-only' | 'read-write';
    readonly rootCount: number;
  };
  readonly limits: {
    readonly maxMetadataBytes: number;
    readonly maxAttachments: number;
    readonly maxFrameBytes: number;
    readonly maxFileBytes: number;
    readonly heartbeatMs: number;
    readonly idleTimeoutMs: number;
  };
}
```

13.4 Rejection response

```ts
export type OpenWorkspaceRejectCode =
  | 'ACCESS_DENIED'
  | 'VERSION_UNSUPPORTED'
  | 'INVALID_REQUEST'
  | 'LIMIT_EXCEEDED'
  | 'SERVER_SHUTTING_DOWN';

export interface OpenWorkspaceRejected {
  readonly service: 'mille.remote';
  readonly version: 1;
  readonly type: 'rejected';
  readonly requestId?: string;
  readonly code: OpenWorkspaceRejectCode;
  readonly message: string;
}
```

By default, a missing export and an unauthorized export both produce ACCESS_DENIED. Exact reasons appear only in server logs. The server sends one rejection and closes the stream with AUTH_REJECTED or PROTOCOL_ERROR as appropriate.

13.5 Handshake timeout

The first complete open request MUST arrive within 10 seconds after socket acceptance. No host is created or acquired before the request validates and authorization succeeds. The client MUST receive acceptance within 15 seconds or fail the attempt with TIMEOUT. These timers are configurable downward but not disabled in remote mode.

13.6 Heartbeat messages

```ts
interface RemotePing {
  service: 'mille.remote';
  version: 1;
  type: 'ping';
  nonce: string;
  sentAtMs: number;
}

interface RemotePong {
  service: 'mille.remote';
  version: 1;
  type: 'pong';
  nonce: string;
  sentAtMs: number;
}
```

Heartbeats are service-layer messages and never reach FileExplorerHost. Either side sends a ping after heartbeatMs without traffic. The peer replies immediately. Absence of any inbound frame for idleTimeoutMs closes the channel as a transport timeout.

14. Truffle integration API

14.1 Server API

```ts
export interface MilleExportConfig {
  readonly label: string;
  readonly roots: readonly string[];
  readonly access: 'read-only' | 'read-write';

  /** Phase 1 remote exports require false. */
  readonly followSymlinks?: false;

  readonly explorer?: Omit<
    ExplorerOptions,
    'roots' | 'followSymlinks'
  >;

  readonly allowedPeerIds?: readonly string[];
  readonly maxFileBytes?: number;        // default 16 MiB
  readonly maxSessions?: number;         // default 16
}

export interface AuthorizeMillePeerContext {
  readonly peerId: string;
  readonly peerName?: string;
  readonly exportId: string;
  readonly requestedAccess: 'read-only' | 'read-write';
  readonly configuredAccess: 'read-only' | 'read-write';
}

export interface ServeMilleOptions {
  readonly port?: number;                // default 9451
  readonly exports: Readonly<Record<string, MilleExportConfig>>;
  readonly authorize?: (
    context: AuthorizeMillePeerContext,
  ) => boolean | Promise<boolean>;
  readonly logger?: MilleRemoteLogger;
  readonly hostIdleTimeoutMs?: number;   // default 5 minutes
  readonly maxSessionsPerPeer?: number;  // default 4
  readonly heartbeatMs?: number;         // default 20 seconds
  readonly idleTimeoutMs?: number;       // default 60 seconds
}

export interface MilleRemoteServer extends AsyncDisposable {
  readonly port: number;
  listSessions(): readonly RemoteSessionInfo[];
  close(): Promise<void>;
}

export function serveMille(
  mesh: MeshNode,
  options: ServeMilleOptions,
): Promise<MilleRemoteServer>;
```

14.2 Client API

```ts
export interface ReconnectOptions {
  readonly minDelayMs?: number; // default 500
  readonly maxDelayMs?: number; // default 10_000
  readonly multiplier?: number; // default 1.8
  readonly jitter?: number;      // default 0.2, range 0..1
}

export interface ConnectMilleOptions {
  readonly peer: Peer;
  readonly port?: number;        // default 9451
  readonly exportId: string;
  readonly access?: 'read-only' | 'read-write'; // default read-only
  readonly clientName?: string;
  readonly reconnect?: false | ReconnectOptions;
  readonly channel?: FramedStreamChannelOptions;
  readonly signal?: AbortSignal;
  readonly logger?: MilleRemoteLogger;
}

export type RemoteConnectionState =
  | 'connecting'
  | 'online'
  | 'stale'
  | 'reconnecting'
  | 'closed';

export interface RemoteConnectionEvent {
  readonly state: RemoteConnectionState;
  readonly attempt: number;
  readonly workspaceInstanceId?: string;
  readonly error?: RemoteExplorerError;
}

export interface RemoteIdentityResetEvent {
  readonly previousWorkspaceInstanceId: string;
  readonly workspaceInstanceId: string;
}

export interface RemoteFileExplorer extends Disposable {
  readonly state: RemoteConnectionState;
  readonly peerId: string;
  readonly exportId: string;
  readonly workspaceInstanceId?: string;

  ready(): Promise<void>;
  close(): Promise<void>;

  on(
    event: 'connection',
    listener: (event: RemoteConnectionEvent) => void,
  ): Disposable;

  on(
    event: 'identityReset',
    listener: (event: RemoteIdentityResetEvent) => void,
  ): Disposable;

  /** Delegates the normal PortFileExplorer surface to the active session. */
  readonly explorer: PortFileExplorer;
}

export function connectMille(
  mesh: MeshNode,
  options: ConnectMilleOptions,
): Promise<RemoteFileExplorer>;
```

> **Mesh ownership:** `serveMille()` and `connectMille()` borrow the caller-owned MeshNode. Disposing a Mille server or client must not close the MeshNode or affect unrelated Truffle services.

14.3 Canonical usage

```ts
// Computer that owns the files
const server = await serveMille(mesh, {
  port: 9451,
  exports: {
    mille: {
      label: 'Mille repository',
      roots: ['/home/james/projects/mille'],
      access: 'read-write',
      followSymlinks: false,
    },
  },
  authorize: ({ peerId, exportId, requestedAccess }) =>
    policy.allows(peerId, exportId, requestedAccess),
});
```

```ts
// Client computer
const remote = await connectMille(mesh, {
  peer,
  exportId: 'mille',
  access: 'read-write',
  reconnect: {},
});

await remote.ready();
const explorer = remote.explorer;
const snapshot = explorer.getSnapshot();
```

15. Export and workspace lifecycle

15.1 Export validation

• Export IDs MUST match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.
• Every root MUST be an absolute local filesystem path.
• Roots MUST be canonicalized once at service startup; startup fails if a root cannot be resolved or read.
• Duplicate canonical roots within an export are rejected.
• Overlapping exports are allowed only when explicitly configured; the server SHOULD log a warning.
• Phase 1 rejects followSymlinks values other than false for remote exports.
• A read-write export MUST pass a startup write-capability probe or be downgraded/rejected according to explicit configuration; silent downgrade is not allowed.

15.2 Host cache

The server maintains one live FileExplorerHost per normalized export configuration. The key is the export ID plus a stable fingerprint of roots and explorer options. Authorization is per session and is not part of the host key.

```ts
interface HostCacheEntry {
  readonly exportId: string;
  readonly fingerprint: string;
  readonly workspaceInstanceId: string;
  readonly host: FileExplorerHost;
  sessionCount: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}
```

• First authorized connection creates the host and generates workspaceInstanceId as a UUID.
• Subsequent sessions attach to the same host.
• When session count reaches zero, the host remains alive for hostIdleTimeoutMs (default five minutes).
• A new session during the idle lease cancels disposal and observes the same EntryIds and workspace instance.
• Service shutdown closes listeners, rejects new opens, closes sessions, and disposes every host.
• A future dynamic export update replaces the host and therefore changes workspaceInstanceId.

15.3 Remote reference

Persistent configuration should store a stable Truffle device ID and export ID, not an absolute remote path. A display-only URI MAY use mille+truffle://<deviceId>/<exportId>. Credentials and filesystem roots MUST NOT appear in this URI.

16. Authorization and operation policy

16.1 Access composition

Effective access is the minimum of the export’s configured access, the client’s requested access, any allowedPeerIds restriction, the authorize callback result, and host policy. A client requesting read-write on a read-only export is rejected rather than silently accepted as read-only.

16.2 Default operation matrix

|Operation / call                   |Read-only          |Read-write         |Admin/local|Notes                                            |
|-----------------------------------|-------------------|-------------------|-----------|-------------------------------------------------|
|Handshake, ack, viewport, expansion|Allow              |Allow              |Allow      |Session-scoped.                                  |
|Snapshot/delta/watch events        |Allow              |Allow              |Allow      |Paths already constrained by export roots.       |
|readFile, readText                 |Allow              |Allow              |Allow      |Subject to max file bytes.                       |
|resolvePath, findVisiblePrefix     |Allow              |Allow              |Allow      |Must stay within roots.                          |
|probeDestination                   |Allow              |Allow              |Allow      |Result must not expose outside paths.            |
|create, rename, move, delete, copy |Deny EROFS         |Allow              |Allow      |Native capabilities still apply.                 |
|writeFile                          |Deny EROFS         |Allow              |Allow      |Subject to size limit.                           |
|copyFromPath                       |Deny               |Deny by default    |Allow      |External import could escape the export boundary.|
|cancelOperation                    |Own operations only|Own operations only|All        |Ownership check required.                        |
|undo / undo inspection             |Deny               |Deny by default    |Allow      |Undo stack is host-global today.                 |
|client decorations                 |Deny               |Deny by default    |Allow      |Avoid cross-session/shared-state injection.      |
|updateProjectionSettings           |Deny               |Deny               |Allow      |Host-global setting.                             |
|reorderRoots / updateWorkspaceRoots|Deny               |Deny               |Allow      |Export configuration is server-owned.            |
|refreshWorkspaceRoots              |Deny               |Deny               |Allow      |Potentially expensive/global.                    |
|resync(entry)                      |Allow, rate-limited|Allow, rate-limited|Allow      |Only IDs visible to session.                     |
|resyncWorkspace                    |Deny               |Deny by default    |Allow      |Expensive/global.                                |

16.3 Operation ownership

• When a session submits a mutation with operationId, the host atomically claims that ID for the session.
• If another live session already owns the same ID, the host rejects the request with EEXIST.
• Progress and completion records carrying that ID are routed only to the owner session.
• cancelOperation succeeds only for the owner session or an admin session.
• Ownership is released on success, failure, cancellation, session close, or a bounded stale-operation timeout.
• Operation details containing paths MUST NOT be broadcast to unrelated sessions.

16.4 Shared-host global state

The current host has global projection, root, undo, warning, and decoration behavior. Phase 1 preserves one shared host for performance but denies remote access to those global controls. A later architecture may split WorkspaceEngine from ExplorerSession more formally; that is not required before remote TCP support ships.

17. Security model

17.1 Defense in depth

|Layer               |Control                                                                                                        |
|--------------------|---------------------------------------------------------------------------------------------------------------|
|Tailscale           |Grant only intended users/devices access to TCP port 9451 on tagged Mille hosts.                               |
|Truffle             |Use accepted socket `remotePeerId` as verified network identity; do not trust client-declared peer IDs.        |
|Mille remote service|Authorize peer + export + requested access before host attach.                                                 |
|Mille host policy   |Enforce operation matrix on every call and mutation.                                                           |
|Filesystem boundary |Use only server-configured canonical roots; reject traversal, external import, and symlink following.          |
|Resource limits     |Bound frames, file payloads, sessions, pending requests, queue bytes, resync frequency, and operation lifetime.|

17.2 Root-boundary rules

• The client never submits a root path during remote open.
• All URI/path resolution is relative to canonical configured roots.
• Normalization occurs before containment comparison.
• Containment checks use platform-aware case and separator semantics.
• Windows junctions/reparse points and POSIX symlinks are not followed in Phase 1 remote exports.
• A resolvePath request outside the export returns null without revealing whether the target exists.
• Errors sent to remote clients use export-relative display paths where practical; full canonical paths remain in restricted server debug logs.

17.3 Authorization callback behavior

The callback receives only server-observed peer identity and validated export/request data. It MUST complete before the handshake timeout. Exceptions are treated as denial and logged. The service SHOULD cache positive authorization for the lifetime of one connection only unless the application supplies its own policy cache.

17.4 No extra shared secret by default

Tailscale encryption, verified peer identity, restricted grants, and application authorization provide the primary security model. A bearer token MAY be added by an embedding application, but this package does not define or persist one in Phase 1 and never places credentials in URIs.

18. Connection, disconnect, and reconnect behavior

18.1 Client state machine

```text
CONNECTING -- accepted + Mille ready --> ONLINE
    |                                  |  \
    | terminal error                   |   \ socket lost
    v                                  |    v
  CLOSED <-----------------------------+  STALE
                                           |
                                  reconnect enabled
                                           v
                                      RECONNECTING
                                       |        |
                                  success        terminal rejection
                                       v        v
                                     ONLINE   CLOSED
```

18.2 Online behavior

• The facade delegates calls to one active PortFileExplorer.
• It records the latest expansion changes and viewport request for possible same-instance restoration.
• Pending calls and mutations are owned by the active session only.
• Normal semantic acknowledgements determine operation completion.

18.3 Disconnect behavior

• The active channel closes and rejects all pending requests immediately.
• No mutation is considered successful without its normal result frame.
• The current mirror snapshot remains immutable and readable; state becomes stale.
• New read-only mirror queries continue to work locally.
• New network calls or mutations fail immediately with RemoteExplorerError code OFFLINE.
• The implementation MUST NOT queue filesystem mutations for replay.

18.4 Reconnect schedule

With reconnect enabled, attempts use exponential backoff: delay = min(maxDelay, minDelay * multiplier^attempt) and then apply symmetric jitter. Defaults are 500 ms minimum, 10 seconds maximum, multiplier 1.8, and 20% jitter. Only one reconnect attempt is active. Abort, explicit close, authorization denial, unknown protocol major, and invalid export are terminal.

18.5 Fresh snapshot and identity continuity

• Every reconnect creates a new stream and performs the complete remote-open and Mille handshakes.
• Phase 1 always receives a fresh snapshot; it does not request delta replay.
• If workspaceInstanceId is unchanged, the facade replays tracked expansion IDs and the last viewport after the fresh snapshot is ready.
• If workspaceInstanceId changed, EntryIds may be different. The facade clears tracked IDs, emits identityReset, and does not replay ID-based state.
• Applications that need to restore selection across identity reset should persist a URI/path and resolve it again after reconnect.

18.6 Server shutdown

Graceful server close stops accepting sockets, marks the service as shutting down, sends a close reason to sessions, waits up to five seconds for queued output to drain, destroys remaining sockets, and disposes hosts. Client reconnect treats SERVER_SHUTTING_DOWN as retryable only when explicitly configured.

19. Errors and diagnostics

19.1 Remote error class

```ts
export type RemoteExplorerErrorCode =
  | 'OFFLINE'
  | 'ACCESS_DENIED'
  | 'PROTOCOL_MISMATCH'
  | 'INVALID_RESPONSE'
  | 'TIMEOUT'
  | 'BACKPRESSURE'
  | 'LIMIT_EXCEEDED'
  | 'SERVER_SHUTTING_DOWN'
  | 'TRANSPORT_ERROR';

export class RemoteExplorerError extends Error {
  readonly name = 'RemoteExplorerError';
  constructor(
    readonly code: RemoteExplorerErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}
```

Filesystem errors continue to use Mille’s existing FileSystemError and ErrorCode. The base ErrorCode union SHOULD add EFBIG for control-stream file-size violations. Transport and service-open failures use RemoteExplorerError.

19.2 Error mapping

|Condition                         |Client error                                                |Connection              |
|----------------------------------|------------------------------------------------------------|------------------------|
|Read-only mutation                |`FileSystemError(EROFS)`                                    |Remain open             |
|File exceeds maxFileBytes         |`FileSystemError(EFBIG)`                                    |Remain open             |
|Unauthorized open                 |`RemoteExplorerError(ACCESS_DENIED)`                        |Close                   |
|Unknown wire major / invalid magic|`RemoteExplorerError(PROTOCOL_MISMATCH or INVALID_RESPONSE)`|Close                   |
|Malformed frame after open        |`RemoteExplorerError(INVALID_RESPONSE)`                     |Close session           |
|Outbound hard queue exceeded      |`RemoteExplorerError(BACKPRESSURE)`                         |Close session           |
|Socket lost with pending request  |`RemoteExplorerError(OFFLINE)`                              |Stale/reconnect         |
|Handshake deadline exceeded       |`RemoteExplorerError(TIMEOUT)`                              |Close/retry             |
|Native filesystem error           |Existing `FileSystemError`                                  |Remain open unless fatal|

19.3 Error disclosure

Remote-facing messages MUST be actionable but not disclose unrestricted canonical paths, hidden exports, authorization rules, stack traces, or peer lists. Logs may contain a correlation ID and full exception under the embedding application’s configured log policy.

20. Backpressure, limits, and performance

20.1 Write scheduling

• The framed channel serializes and writes messages in order.
• If stream.write() returns false, no later frame is written until drain fires.
• bufferedBytes includes encoded frames not yet accepted by the stream, not bytes already owned by the operating system.
• At the soft watermark, callers may continue sending until the hard limit, but host/client loops SHOULD await drain() before optional/non-urgent output.
• At the hard limit, the channel closes with BACKPRESSURE rather than consuming unbounded memory.
• Snapshot/delta coalescing remains controlled by Mille’s existing host tick and acknowledgement logic.

20.2 Per-connection limits

|Resource                      |Default                                                 |
|------------------------------|--------------------------------------------------------|
|Open-handshake timeout        |10 seconds server receive / 15 seconds client acceptance|
|Heartbeat interval            |20 seconds of no traffic                                |
|Idle timeout                  |60 seconds without inbound frame                        |
|Pending client requests       |1,024                                                   |
|Sessions per peer             |4                                                       |
|Sessions per export           |16                                                      |
|Owned operations per session  |64                                                      |
|Entry resync requests         |10 per minute per session                               |
|File content on control stream|16 MiB per request/result                               |
|Outbound hard queue           |32 MiB                                                  |

20.3 Performance invariants

• PERF-001 — Opening or expanding a remote directory MUST NOT issue one network request per child entry.
• PERF-002 — One expansion action SHOULD require at most one client-to-host control message plus the normal resulting snapshot/delta traffic.
• PERF-003 — The client MUST continue to use Mille’s bounded mirror and viewport patching; it MUST NOT materialize the complete remote tree solely because transport is networked.
• PERF-004 — The stream codec SHOULD add less than 5% size overhead to binary-heavy snapshot/delta frames, excluding the semantic JSON metadata already required.
• PERF-005 — Encoding and decoding a 1 MiB binary-heavy frame SHOULD each complete within 5 ms p95 on the project’s reference development machine.
• PERF-006 — The MessagePort path SHOULD not regress more than 5% median or p95 against the pre-refactor benchmark.

20.4 Compression

Compression is disabled in Phase 1. The wire header reserves a flag, but neither side may set it. After measuring actual snapshot/delta payloads, a future minor protocol may negotiate zstd or another codec only above a threshold. Tailscale encryption is not compression.

21. Observability

21.1 Structured logs

|Event                      |Required fields                                                              |
|---------------------------|-----------------------------------------------------------------------------|
|server_listening           |port, export count                                                           |
|open_requested             |connection ID, peer ID, export ID, requested access                          |
|open_accepted              |connection ID, session ID, workspace instance ID, effective access           |
|open_rejected              |connection ID, peer ID, coarse reason; exact reason only at debug            |
|channel_closed             |connection ID, session ID, close code, queued bytes                          |
|reconnect_attempt          |peer ID, export ID, attempt, scheduled delay                                 |
|identity_reset             |old/new workspace instance IDs                                               |
|limit_exceeded             |limit name and observed value; no file contents                              |
|operation_started/completed|session ID, operation ID, operation kind, duration; paths redacted by default|

21.2 Metrics hook

```ts
export interface MilleRemoteMetrics {
  increment(name: string, value?: number, tags?: Record<string, string>): void;
  observe(name: string, value: number, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
}
```

Metrics are optional and adapter-based. Recommended measurements include active sessions, host cache size, encoded/decoded bytes, queue high-water mark, frame decode failures, open latency, reconnect count, snapshot bytes, delta bytes, and operation duration.

21.3 Correlation IDs

Every accepted socket gets a random connection ID. Every remote open gets a session ID. Existing mutation and call request IDs remain visible in trace logs. IDs are safe to return to clients for support, but they must not be treated as authentication secrets.

22. Compatibility and versioning

22.1 Three independent versions

|Version                |Phase 1                         |Responsibility                                 |
|-----------------------|--------------------------------|-----------------------------------------------|
|Mille semantic protocol|Existing `PROTOCOL_VERSION = 1` |Snapshot/delta/call/mutation message semantics.|
|Framed stream wire     |`STREAM_WIRE_MAJOR = 1`, minor 0|Byte framing and binary attachments.           |
|Remote service protocol|`REMOTE_SERVICE_VERSION = 1`    |Open/export/authorization/heartbeat messages.  |

Do not increment the semantic Mille protocol solely because it is now framed. Binary read/write cleanup is runtime-compatible: new clients accept legacy arrays, and old array-like conversion accepts Uint8Array. Any future incompatible semantic change increments the semantic protocol independently.

22.2 Wire negotiation

• Unknown wire major is fatal.
• A higher minor version is accepted only when all active flags and fields are understood or explicitly ignorable.
• Unknown nonzero flags are fatal in Phase 1.
• Remote service version mismatch produces a rejection before attaching the Mille host.
• Limits in OpenWorkspaceAccepted may only reduce the client’s configured maxima.

22.3 Package exports

```ts
// @vibecook/mille
export { createMessagePortHostChannel, createMessagePortClientChannel };
export type { ExplorerChannel, ExplorerHostChannel, ExplorerClientChannel };
export { connectFileExplorerChannel };

// @vibecook/mille/node
export {
  createFramedStreamHostChannel,
  createFramedStreamClientChannel,
};

// @vibecook/mille-truffle
export { serveMille, connectMille, RemoteExplorerError };
```

22.4 Public API compatibility

• Existing createFileExplorerHost, attachPort, and connectFileExplorer signatures remain valid.
• Existing local consumers do not need Truffle or Node stream types.
• The current PortFileExplorer name is retained in Phase 1 to avoid a broad rename.
• New errors and events are additive.
• Remote APIs are initially marked experimental until two-device acceptance and one release cycle complete.

23. File-by-file implementation plan

23.1 packages/mille

|File                          |Change                                                                                                                                          |
|------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
|`src/channel/types.ts`        |Add channel state, close event, typed channel interfaces, logger types.                                                                         |
|`src/channel/message-port.ts` |Move/adapt MessagePort event handling, transfer-list extraction, and lifecycle into channel factories.                                          |
|`src/stream/codec.ts`         |Implement semantic-object traversal, binary attachment extraction, placeholder reconstruction, and bounds checks.                               |
|`src/stream/decoder.ts`       |Implement segmented incremental parser supporting arbitrary fragmentation/coalescing.                                                           |
|`src/stream/framed-channel.ts`|Implement ordered write queue, Node backpressure, drain, close-once semantics, and Duplex events.                                               |
|`src/host.ts`                 |Replace session port with channel; add `attachChannel`; add context/policy checks, operation ownership, warning routing, effective capabilities.|
|`src/client-port.ts`          |Accept channel, listen for close, reject pending work, expose connection event, use binary file payloads.                                       |
|`src/protocol.ts`             |Keep semantic shapes; widen read/write payload runtime types if needed; add helpers for binary extraction tests.                                |
|`src/types.ts` / `api.d.ts`   |Expose new channel/session types, `attachChannel`, `EFBIG`, and connection event.                                                               |
|`src/index.ts`                |Export browser-safe channel and wrapper APIs only.                                                                                              |
|`src/node.ts`                 |Export framed stream factories.                                                                                                                 |
|`package.json`                |Add `./node` conditional export and types; keep root browser-safe.                                                                              |

23.2 packages/mille-truffle

|File              |Change                                                                                                                                  |
|------------------|----------------------------------------------------------------------------------------------------------------------------------------|
|`src/handshake.ts`|Types, validators, request correlation, heartbeat, coarse rejections.                                                                   |
|`src/exports.ts`  |Validate IDs, canonicalize roots, enforce symlink policy, fingerprint host configuration.                                               |
|`src/server.ts`   |Create Truffle TCP listener, enforce handshake timeout, authorize, acquire host, attach channel, maintain sessions and host idle leases.|
|`src/client.ts`   |Connect socket, perform open handshake, construct core client, implement stale snapshot and reconnect facade.                           |
|`src/state.ts`    |Explicit connection-state reducer and backoff calculation.                                                                              |
|`src/authorize.ts`|Compose allowedPeerIds, configured access, and callback.                                                                                |
|`src/errors.ts`   |RemoteExplorerError and safe error mapping.                                                                                             |
|`src/types.ts`    |Public options and session/server information.                                                                                          |
|`src/index.ts`    |Public exports.                                                                                                                         |
|`package.json`    |Peer dependencies on Mille and Truffle; Node-only engine declaration.                                                                   |

23.3 Host dispatch hardening tasks

• Create authorizeMutation(session, body) and authorizeCall(session, method, args) tables rather than scattered conditionals.
• Mask capabilities responses through effectiveCapabilities(session).
• Reject operation-ID collision before dispatch and release ownership on every terminal path.
• Route operation progress by operationId; never fan out path-bearing progress to unrelated sessions.
• Apply per-session resync rate limit.
• Reject remote copyFromPath even if native capabilities otherwise allow it.
• Guarantee session disposal clears timers, pending ownership, and channel listeners.

24. Test plan

24.1 Channel contract tests

• Ordered delivery for 10,000 messages.
• Send-after-close throws.
• Close is idempotent and emits once.
• Listener disposal stops callbacks.
• drain() waits through simulated backpressure.
• Hard outbound limit terminates deterministically.
• Transport error rejects pending work and does not dispose the shared host.

24.2 Codec property and fuzz tests

• Round-trip every semantic message type.
• Round-trip nested ArrayBuffer, Buffer, DataView, and typed-array slices with nonzero byte offsets.
• Feed one byte at a time.
• Feed many frames in one chunk.
• Randomly partition a valid byte stream and compare decoded output.
• Reject bad magic, unsupported major, active unknown flag, invalid UTF-8, invalid JSON, attachment-count mismatch, sum mismatch, invalid placeholder index, cycles, and size overflow.
• Run a bounded mutation fuzzer against header lengths and attachment tables.
• Verify no allocation proportional to an unvalidated attacker-supplied length.

24.3 Core host/client integration tests

• Connect a real FileExplorerHost and PortFileExplorer using paired PassThrough streams.
• Browse, expand, set viewport, receive snapshot/delta, read/write files, and acknowledge ticks.
• Abruptly destroy the stream with pending call and mutation; assert deterministic rejection and frozen snapshot.
• Verify MessagePort wrappers produce unchanged behavior.
• Verify read-only mutation rejection and effective capability masking.
• Verify global/admin calls are denied remotely.
• Verify two sessions cannot cancel each other’s operation or receive each other’s progress.
• Verify one malformed client session does not stop a second session or dispose the host.

24.4 Truffle package tests

• Unit-test listener and client with a fake MeshNode returning Duplex pairs.
• Reject invalid export IDs and noncanonical/unreadable roots at startup.
• Reject unauthorized peer before host factory invocation.
• Reject read-write request on a read-only export.
• Reuse host for two authorized sessions; dispose after idle lease.
• Enforce per-peer and per-export session limits.
• Heartbeat keeps a quiet connection open; missing pong reaches stale/closed.
• Reconnect to same workspace instance restores tracked expansion/viewport.
• Reconnect to new workspace instance emits identityReset and does not replay IDs.
• Explicit close cancels reconnect and does not close MeshNode.

24.5 Security tests

• Reject .., absolute path injection, mixed separators, case aliasing, and URI encoding tricks.
• Verify symlinks/junctions are not followed in remote Phase 1.
• Verify resolvePath outside roots returns null and does not disclose existence.
• Verify copyFromPath, root mutation, projection mutation, undo, workspace resync, and decorations are denied by default.
• Verify unknown export and denied export have the same remote response.
• Verify client-supplied peer identity is ignored in favor of socket identity.
• Verify logs contain no file contents and default path redaction works.

24.6 Performance tests

• Compare existing MessagePort benchmark before and after channel refactor.
• Encode/decode 1 MiB and 16 MiB binary-heavy frames; report median and p95.
• Simulate 25 ms and 100 ms RTT with fragmented PassThrough transport and verify expansion incurs no per-entry round trips.
• Generate 1,000 watcher changes in one host tick and verify coalesced delta behavior.
• Hold the receiver under backpressure and verify queue memory stays within limits.
• Serve two clients from one host and verify one slow client does not create an unbounded queue or delay native state production for the other.

25. Acceptance criteria

• AC-001 — All pre-existing Mille tests pass without application-code changes.
• AC-002 — A sample Electron/Node client on one tailnet device can browse a configured export on a second device.
• AC-003 — Create, rename, move, delete, read, and write work on a read-write export and are rejected on a read-only export.
• AC-004 — Remote filesystem changes appear through the existing watcher/delta path without polling each file from the client.
• AC-005 — Disconnect leaves the last snapshot usable, rejects pending work, and enters stale/reconnecting state.
• AC-006 — Reconnect to the live host returns online and restores expansion/viewport; host restart emits identityReset.
• AC-007 — An unauthorized peer cannot acquire a host or learn whether a named export exists.
• AC-008 — Traversal, symlink/junction escape, and external import security tests pass on supported operating systems.
• AC-009 — The outbound queue, inbound frame, pending-request, session, operation, and file-size bounds are demonstrated by tests.
• AC-010 — MessagePort performance regression is under 5% median and p95, or an explicit benchmark waiver documents the reason.
• AC-011 — Two-client shared-host testing demonstrates independent viewport/expansion state and isolated operation progress.
• AC-012 — The package docs include server setup, client setup, Tailscale policy guidance, failure behavior, and limitations.

26. Delivery plan and PR sequence

PR 1 — Channel abstraction and compatibility

• Add channel types and MessagePort adapter.
• Add attachChannel and connectFileExplorerChannel.
• Keep existing wrappers and tests green.
• No network code and no behavior change.

Merge gate: existing API and benchmark suite passes; new channel contract tests pass.

PR 2 — Framed Node stream transport

• Add codec, decoder, Node Duplex channel, limits, and ./node entry point.
• Add fragmentation, malformed-frame, binary-view, and backpressure tests.
• Add PassThrough host/client integration test.

Merge gate: complete frame test matrix, bounded-memory checks, and no browser bundle regression.

PR 3 — Session policy and remote hardening

• Add explicit session context/policy.
• Add permission tables, capability masking, operation ownership, progress routing, resync limits, and binary file cleanup.
• Add multi-session and security tests.

Merge gate: all policy matrix tests and shared-host isolation tests pass.

PR 4 — Mille Truffle server

• Create package, export validation, open handshake, Truffle TCP listener, authorization, host cache, and shutdown.
• Add fake-mesh tests and manual server example.

Merge gate: unauthorized peers never create hosts; two clients share one host; cleanup is leak-free.

PR 5 — Mille Truffle client and reconnect facade

• Add connect/open flow, RemoteFileExplorer, heartbeat, stale snapshot, backoff, same-instance restoration, and identity reset.
• Add deterministic state-machine and failure-injection tests.

Merge gate: reconnect scenarios pass with fake transport and local Truffle test runtime.

PR 6 — Tailnet acceptance, docs, and release

• Run two-device Linux/macOS and Windows combinations where available.
• Add Tailscale grants example and operational documentation.
• Record performance results and known Phase 1 limits.
• Publish experimental package release and migration notes.

Recommended release shape

Ship the channel and stream pieces in the next Mille minor release. Ship @vibecook/mille-truffle as 0.x experimental for one release cycle. Promote it after tailnet production use confirms reconnect, host lifecycle, and permission behavior.

27. Risks, mitigations, and deferred work

|Risk                                                            |Impact                                          |Mitigation / decision                                                                                     |
|----------------------------------------------------------------|------------------------------------------------|----------------------------------------------------------------------------------------------------------|
|One shared host has global undo/projection/decorations.         |Cross-session interference or data disclosure.  |Deny these APIs remotely in Phase 1; later split engine and session layers.                               |
|Control stream carries large file content.                      |Head-of-line blocking and high memory.          |Cap at 16 MiB; add QUIC content streams later.                                                            |
|EntryIds change after host restart.                             |Selections/expansion become invalid.            |Workspace instance ID; same-instance replay only; path-based recovery event.                              |
|Slow client causes queued deltas.                               |Memory growth.                                  |Hard queue limit, ack/coalescing, close slow session without affecting host.                              |
|Tailscale reachability is mistaken for filesystem authorization.|Overbroad access.                               |Require application authorization and host policy in addition to grants.                                  |
|Symlinked dependency trees are useful in development.           |Phase 1 `followSymlinks:false` may hide targets.|Treat symlink-safe export semantics as a later audited feature; do not weaken boundary in initial release.|
|Truffle API evolves.                                            |Integration breakage.                           |Keep adapter thin, pin compatible peer range, test against Truffle release CI.                            |
|JSON metadata encoding overhead.                                |CPU/size cost.                                  |Binary-heavy payloads remain attachments; profile before adopting a binary metadata codec.                |

27.1 Future work

• QUIC control + independent read/write/search streams.
• Resumable sessions with bounded server delta ring and resume tokens.
• Idempotent mutation replay by durable operation ID.
• Per-session projection settings backed by a cleaner WorkspaceEngine/ExplorerSession split.
• Audited symlink policy supporting selected in-workspace links.
• Chunked large-file reads/writes and content hashes.
• Cross-export streamed copy with verify-then-delete semantics.
• Agentless ProviderExplorerEngine for SFTP, WebDAV, cloud APIs, and archives.
• Service discovery/advertisement through Truffle application messaging.

Appendix A. Complete public API sketch

```ts
// @vibecook/mille/channel
export type ExplorerChannelState = 'open' | 'closing' | 'closed';
export type ExplorerChannelCloseCode =
  | 'LOCAL_CLOSE'
  | 'REMOTE_CLOSE'
  | 'TRANSPORT_ERROR'
  | 'PROTOCOL_ERROR'
  | 'BACKPRESSURE'
  | 'AUTH_REJECTED';

export interface ExplorerChannelCloseEvent {
  readonly code: ExplorerChannelCloseCode;
  readonly reason?: string;
  readonly cause?: unknown;
}

export interface ExplorerChannel<TOutbound, TInbound> extends Disposable {
  readonly state: ExplorerChannelState;
  readonly bufferedBytes: number;
  send(message: TOutbound): void;
  drain(): Promise<void>;
  onMessage(listener: (message: TInbound) => void): Disposable;
  onClose(listener: (event: ExplorerChannelCloseEvent) => void): Disposable;
  close(reason?: string): void;
}

export type ExplorerHostChannel = ExplorerChannel<
  HostToClientMessage,
  ClientToHostMessage
>;
export type ExplorerClientChannel = ExplorerChannel<
  ClientToHostMessage,
  HostToClientMessage
>;

export function createMessagePortHostChannel(
  port: MessagePortLike,
): ExplorerHostChannel;
export function createMessagePortClientChannel(
  port: MessagePortLike,
): ExplorerClientChannel;

export interface ExplorerSessionPolicy {
  readonly access: 'admin' | 'read-write' | 'read-only';
  readonly allowClientDecorations?: boolean;
  readonly allowProjectionMutation?: boolean;
  readonly allowWorkspaceRootMutation?: boolean;
  readonly allowExternalImport?: boolean;
  readonly allowUndo?: boolean;
  readonly allowWorkspaceResync?: boolean;
}

export interface ExplorerSessionContext {
  readonly kind?: 'local' | 'remote';
  readonly clientId?: string;
  readonly peerId?: string;
  readonly peerName?: string;
  readonly exportId?: string;
  readonly policy?: ExplorerSessionPolicy;
}

export interface FileExplorerHost extends Disposable {
  attachChannel(
    channel: ExplorerHostChannel,
    context?: ExplorerSessionContext,
  ): Disposable;
  attachPort(port: MessagePortLike): Disposable;
  local: FileExplorer;
}

export function connectFileExplorerChannel(
  channel: ExplorerClientChannel,
  options?: PortFileExplorerOptions,
): PortFileExplorer;
export function connectFileExplorer(
  port: MessagePortLike,
  options?: PortFileExplorerOptions,
): PortFileExplorer;

// @vibecook/mille/node
export interface FramedStreamChannelOptions {
  readonly maxMetadataBytes?: number;
  readonly maxAttachments?: number;
  readonly maxFrameBytes?: number;
  readonly outboundSoftBytes?: number;
  readonly outboundHardBytes?: number;
  readonly logger?: ExplorerChannelLogger;
}

export function createFramedStreamHostChannel(
  stream: Duplex,
  options?: FramedStreamChannelOptions,
): ExplorerHostChannel;
export function createFramedStreamClientChannel(
  stream: Duplex,
  options?: FramedStreamChannelOptions,
): ExplorerClientChannel;

// @vibecook/mille-truffle
export function serveMille(
  mesh: MeshNode,
  options: ServeMilleOptions,
): Promise<MilleRemoteServer>;

export function connectMille(
  mesh: MeshNode,
  options: ConnectMilleOptions,
): Promise<RemoteFileExplorer>;
```

Appendix B. Wire examples

B.1 Open request metadata

```json
{
  "service": "mille.remote",
  "version": 1,
  "type": "open",
  "requestId": "5bff6bb1-6e65-44a2-b0bb-c6fde1686061",
  "exportId": "mille",
  "requestedAccess": "read-write",
  "client": {
    "instanceId": "c5ff56f8-1376-4e52-8e32-861d1aa7e1c6",
    "name": "James MacBook",
    "milleVersion": "0.3.x",
    "milleTruffleVersion": "0.1.x"
  }
}
```

B.2 Semantic snapshot with attachments

```json
{
  "v": 1,
  "type": "snapshot",
  "body": {
    "version": 42,
    "mirror": { "$mille": "bin", "i": 0 },
    "childListsBin": { "$mille": "bin", "i": 1 },
    "viewportPatch": { "$mille": "bin", "i": 2 }
  }
}
```

The frame’s attachment-length table contains three lengths in the same index order, followed by the exact raw bytes of the three payloads.

Appendix C. Tailscale policy example

The exact policy syntax should be validated against the organization’s current Tailscale configuration. The intent is to restrict the Mille TCP port to approved developers and tagged Mille hosts, while the application still performs peer/export authorization.

```json
{
  "groups": {
    "group:developers": [
      "alice@example.com",
      "james@example.com"
    ]
  },
  "grants": [
    {
      "src": ["group:developers"],
      "dst": ["tag:mille-host"],
      "ip": ["tcp:9451"]
    }
  ]
}
```

> **Important:** Tailscale port access is necessary but not sufficient. The Mille service still checks `remotePeerId`, export policy, requested access, and per-operation permissions.

Appendix D. Source baseline

The implementation should re-check repository heads before coding. This specification was derived from the following current sources inspected on July 25, 2026:

|Source               |URL                                                                              |Used for                                                              |
|---------------------|---------------------------------------------------------------------------------|----------------------------------------------------------------------|
|Mille repository     |https://github.com/vibecook-dev/mille                                            |Public API, host/client split, protocol, native/provider architecture.|
|Mille API declaration|https://github.com/vibecook-dev/mille/blob/main/packages/mille/api.d.ts          |MessagePort APIs, capabilities, EntryId and provider contracts.       |
|Mille host           |https://github.com/vibecook-dev/mille/blob/main/packages/mille/src/host.ts       |Concrete session, mutation, tick, warning, and call dispatch behavior.|
|Mille client         |https://github.com/vibecook-dev/mille/blob/main/packages/mille/src/client-port.ts|PortFileExplorer mirror/RPC behavior.                                 |
|Mille protocol       |https://github.com/vibecook-dev/mille/blob/main/packages/mille/src/protocol.ts   |Semantic frame shapes and binary buffers.                             |
|Truffle repository   |https://github.com/vibecook-dev/truffle                                          |Tailscale-native networking and package architecture.                 |
|Truffle TCP API      |https://github.com/vibecook-dev/truffle/blob/main/packages/core/src/net.ts       |Node Duplex sockets, server/connect APIs, peer identity.              |
|Truffle QUIC API     |https://github.com/vibecook-dev/truffle/blob/main/packages/core/src/quic.ts      |Independent ordered streams for future content multiplexing.          |
|Tailscale grants     |https://tailscale.com/docs/features/access-control/grants                        |Port/protocol/device access-control model.                            |

Repository snapshots observed during analysis: Mille head 5f2852e6e9bdee482ac98215bd29b18151c52c93; Truffle head 09367f6ced4c0030ce1ca42c3ab762923e7529f3 / release line v0.7.6. Treat these hashes as provenance, not as permanent compatibility requirements.

Implementation kickoff checklist

• Create tracking issue and link this specification.
• Pin baseline benchmark results before PR 1.
• Assign owners for channel/codec, host policy, and Truffle integration.
• Decide whether @vibecook/mille-truffle is a sibling monorepo package or standalone package.
• Confirm Truffle package import names and minimum compatible version.
• Confirm test operating-system matrix and one two-device tailnet environment.
• Implement PRs in the sequence defined in Section 26; do not combine policy hardening and transport framing into one review.
