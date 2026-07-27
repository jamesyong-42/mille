# Remote Workspace over Truffle — Implementation Plan

**Status:** Proposed · **Date:** 2026-07-25 · **Spec:** [`draft/mille-truffle-spec.md`](../draft/mille-truffle-spec.md)

Validated against Mille head `31cd543` and Truffle head `09367f6` / **v0.7.6** — the exact commit the
spec cites in Appendix D. The spec's assumptions hold. This plan records what Truffle 0.7.6 actually
guarantees, the two places that changes the spec's security design, and the PR order.

## Goal

Browse, watch, search, and mutate a workspace on another tailnet device through the same Mille API
used locally, by running the existing native explorer host beside the files and carrying the existing
host/client mirror protocol over one ordered stream. Truffle is an `ExplorerChannel` transport — not
a per-file `FileSystemProvider`. Everything already built (native walker, watcher, `EntryStore`,
delta coalescing, viewport projection, LRU mirror) is preserved.

## Truffle 0.7.6: what we are building on

Layered architecture (RFC 012): Applications → Envelope → Session → Transport → Network → Go sidecar
(tsnet). `truffle-core` is ~12k LOC; `truffle-napi` bridges it to Node.

The JS package is **`@vibecook/truffle`** (`packages/core`, v0.7.6). `createMeshNode()` returns a
`MeshNode` exposing `net`, `http`, `ws`, `quic`, `dgram`, and `serve` namespaces. Mille uses
`mesh.net` only — raw framed binary, no HTTP semantics.

**Depend on `@vibecook/truffle`, never `@vibecook/truffle-native`.** `docs/API-STABILITY.md`
explicitly lists the native package, architecture-specific packages, and undocumented NAPI helpers as
implementation details that are _not_ compatibility surfaces. Also: pre-1.0, **minor releases may
contain breaking API changes** — pin a compatible range and re-verify `net.ts` before PR 4.

### `TruffleSocket` gives us the channel contract for free

`packages/core/src/net.ts:67` — a real `stream.Duplex`, `allowHalfOpen: true`, with the model stated
in its header: _"Backpressure comes from the pull-model native handle: `_read` awaits one native
`read()` at a time, `_write` resolves when the transport accepted the bytes."_ RFC 021 D1 made this
a deliberate design rule: bytes cross NAPI only as the resolution of a JS-initiated promise, never
through a ThreadsafeFunction, because awaiting _is_ the backpressure.

So spec NFR-004 and §20.1 need no custom accounting in Mille: `bufferedBytes` is `writableLength`,
`drain()` is the standard `'drain'` event. And §8.3's "any Node Duplex" rule is satisfied with no
Truffle import in base Mille — `createFramedStreamHostChannel(socket)` just works.

Read size defaults to 64 KiB, matching file-transfer chunking.

## Two findings that change the spec's security design

### 1. Raw TCP listeners are tailnet-authenticated but **app-unauthenticated**

RFC 021 §9, verbatim: _"Any device on the tailnet (subject to Tailscale ACLs) can reach a raw
TCP/UDP listener — unlike the envelope layer, whose WS hello enforces app_id + WhoIs identity."_

There is no `app_id` scoping on `mesh.net`. QUIC gets it via ALPN; TCP does not. **Mille's
`authorize()` is therefore the only application-level gate that exists**, and any process on any
tailnet device can open a socket to port 9451 and speak the open handshake.

This elevates spec SEC-001 (authorize before host attach) and SEC-006 (indistinguishable
unknown/unauthorized responses) from good practice to load-bearing. The handshake timeout (§13.5) and
the default-deny operation matrix (§16.2) are the perimeter, not a second layer behind one.

Appendix C's Tailscale grant restricting `tcp:9451` to `group:developers` is correspondingly
**required, not advisory** — it is the only thing keeping non-developer tailnet devices off the port.

### 2. Authorize on `tailscaleId`, not `deviceId` — the ULID is self-declared

This reverses the earlier recommendation in this plan's history, and Truffle's source says why
directly.

- `peer.ts:249-252` — routing by peer ref is _"keyed by the **authenticated** Tailscale id, not the
  **self-declared** ULID."_
- `peer.ts:86-89` — `deviceId` is _"Durable ULID once known; `null` until identity is learned. …
  **Use only for persistence across restarts.**"_
- `raw_socket.rs:166-168` — inbound `remotePeerId` is the **WhoIs node id**, outbound it is the
  resolved device id; _"`null` means 'anonymous but tailnet-authenticated' (**never gate on it**)."_

The RFC 017 `device_id` arrives in the peer's own hello envelope. It is fine for display and for
persisting a workspace reference, but it must not be the authorization key. The authenticated fact —
established by WireGuard and tsnet `WhoIs`, not by the peer — is the **Tailscale stable node ID**.

**Decision:** `MilleExportConfig.allowedPeerIds` holds Tailscale node IDs, compared against
`socket.remotePeerId` on an inbound socket. A `null` peer id is a denial, never a pass. The
`Peer` handle from `socket.remotePeer` supplies `displayName`/`deviceId` for logging only.

**Measured, 2026-07-26.** Two ephemeral mesh nodes on one machine, a real `FileExplorerHost`
behind `mesh.net.createServer`, a real `PortFileExplorer` over `mesh.net.connect`. The inbound
socket reported:

```
remotePeerId          "nhuoDhUsfh11CNTRL"     Tailscale StableID
remotePeerName        "james yong"            WhoIs display name — a user, not a device
remoteAddress         "100.123.36.55:27567"
remotePeer.tailscaleId "nhuoDhUsfh11CNTRL"
remotePeer.deviceId    null
```

`deviceId` is **null on a raw TCP accept**, confirming the reasoning above by observation rather
than by reading: authorizing on the RFC 017 ULID would have been authorizing on `null`. Note also
that `remotePeerName` came back as the tailnet _user's_ display name, not the device name — useful
for audit lines, useless as a device discriminator.

> Note the namespace asymmetry: `remotePeerId` is a device id **outbound** and a Tailscale node id
> **inbound**. An operator who copies an ID observed client-side and pastes it into `allowedPeerIds`
> will get a silent no-match. Document the source of the value in the export config.

Inbound sockets set this metadata **synchronously in the constructor**, explicitly _"so a
'connection' handler can read remotePeerId/remotePeerName immediately for accept-time gating"_
(`net.ts:107-110`) — exactly what SEC-001 needs, with no async gap.

### Consequence for user-level grants

`TailscalePeerIdentity` carries `login_name` (e.g. `alice@example.com`), but the napi accept path
collapses it: `remotePeerName = display_name || login_name || dns_name` (`raw_socket.rs:224-229`).
JS cannot tell which field it received, so **in-app grants by user email are not reliably possible
today**.

Phase 1 therefore delegates user-level policy to Tailscale grants (Appendix C) and authorizes by node
ID in-app. If in-app user grants are wanted later, that is a small, well-scoped Truffle enhancement:
expose the full `TailscalePeerIdentity` as a structured getter instead of the flattened name.

## Operational limits that bite a long-lived control stream

| Limit                                        | Value                                                        | Consequence for Mille                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidecar reaps idle bridged connections       | 10 min default; `idleTimeoutSecs` knob exists                | **The §13.6 heartbeat is load-bearing, not optional.** At 20 s it keeps the bridge connection alive; without it a quiet workspace dies at 10 minutes. |
| `'timeout'` never fires on a `TruffleSocket` | `net.ts:173-185`                                             | The §20.2 idle timeout must be an application timer. Never rely on socket idle events.                                                                |
| Bridge concurrency                           | 256 TCP conns (`bridge.rs:34`, a semaphore)                  | Node-global and shared with all other TCP/WS use. Mille's 16 sessions/export and 4/peer sit inside that budget — but they are not alone in it.        |
| Reserved ports                               | 9417 (session WS); 443 needs an RFC 023 sidecar              | **9451 is clear.** No change needed.                                                                                                                  |
| Throughput                                   | userspace gVisor netstack, no GSO/GRO, loopback hop each way | "Good, not line-rate." Fine for a control stream; informs the §20.2 16 MiB file cap.                                                                  |
| Raw streams have no frame cap                | (WS envelope's 16 MiB cap does not apply)                    | Mille's own 32 MiB frame / 16 MiB payload limits are the only bound. Enforce them.                                                                    |

`mesh.quic` is fully implemented (`TruffleQuicStream extends Duplex`, async-iterable connections and
streams), so spec §27.1's deferred content multiplexing is reachable when wanted — not blocked. The
Phase 1 choice of `mesh.net` still stands: the control stream is single and ordered.

## Proven end to end, 2026-07-26

Before writing any of `@vibecook/mille-truffle`, the thesis was executed directly: PRs 1–3 plus
`mesh.net` are already enough to serve a workspace across a real tailnet. Two ephemeral nodes, a
genuine host and client, no fake mesh and no `PassThrough`. Eight checks, all passing:

| Check                             | Result                                     |
| --------------------------------- | ------------------------------------------ |
| Handshake over the tailnet        | 20 ms                                      |
| Verified peer identity at accept  | `nhuoDhUsfh11CNTRL`                        |
| Roots delivered                   | 1 root                                     |
| Expansion produced rows           | `src`, `README.md`                         |
| Remote `create`                   | ok                                         |
| Binary write/read round trip      | 26 B, `Uint8Array`                         |
| `resyncWorkspace` denied remotely | `EACCES` — PR 3 policy holds over the wire |
| 512 KiB payload round trip        | 22 ms (≈1 MiB across the wire)             |

Node startup dominates everything else at ~10 s for the pair; once up, the transport is not the
cost. This does **not** discharge AC-002: two tsnet stacks in one process exercise the real
sidecar, WireGuard and framing path, but not NAT traversal, DERP relay, or wide-area latency.
Two physical devices are still required for acceptance.

## PR sequence

Spec §26, unchanged:

1. Channel abstraction and MessagePort adapter — no network code, no behavior change.
2. Framed stream transport — codec, incremental decoder, Duplex channel, `./node` entry.
3. Session policy and remote hardening — permission tables, capability masking, operation ownership.
4. Mille Truffle server — export validation, open handshake, `mesh.net.createServer`, host cache.
5. Mille Truffle client and reconnect facade.
6. Tailnet acceptance, docs, release.

PRs 1–3 are transport-neutral — the spec's §24.3 tests build them on paired `PassThrough` streams, so
they need no tailnet and no Truffle dependency, and can start now. PRs 4–5 consume `mesh.net`.

Because `mesh.net` already delivers an authenticated Duplex with correct backpressure,
`@vibecook/mille-truffle` is thinner than §14 implies: open handshake, export validation,
authorization composition, host cache, reconnect facade. No socket plumbing, no identity resolution,
no backpressure machinery.

## Corrections to apply while implementing

Verified against the current Mille tree:

- **`ErrorCode` needs `EFBIG`** (spec §19.1) — absent from `packages/mille/api.d.ts`; add there and
  in `crates/mille-core/src/error.rs`.
- **`packages/mille` has no `./node` export** — six subpaths today; PR 2 adds the seventh.
- **§12.5's binary-payload cleanup is real.** `client-port.ts:515` does `as number[]` then
  `Uint8Array.from`; `:526` does `Array.from(data)`.
- **Spec §12.2's `Session` sketch is incomplete** — the real one also carries `lastRootIds`,
  `ackedVersion`, `ackCapable`. Preserve them.
- **Repository references — fixed 2026-07-26.** After the transfer to `vibecook-dev`, seventeen
  files still pointed at `jamesyong-42/mille`, plus a `Cargo.toml` entry naming a repository that
  never moved (`jamesyong/file-explorer`). An earlier note here claimed the stale references still
  resolved via GitHub's post-transfer redirect. That is true of `github.com` repo URLs and **not**
  of GitHub Pages: `jamesyong-42.github.io/mille` returned 404 while `vibecook-dev.github.io/mille`
  returned 200, so the README's documentation links were simply broken. All references now point at
  `vibecook-dev`, matching what Truffle did for itself in `c73837e`.
- **`8628354` helps** — mutation sync points are now genuinely acknowledged rather than
  `setImmediate`-timed, which §18.3 and §20.1 both lean on.

## Environment

The local Truffle checkout was 159 commits stale until 2026-07-25 (pulled to `09367f6`). Its
`node_modules` still holds `@vibecook/truffle-native` 0.3.25 against a 0.7.6 workspace — run
`pnpm install` in `D:/Projects/p100/truffle` before building or type-checking there.

## Open risks

| Risk                                                            | Mitigation                                                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Truffle is pre-1.0 and moved 0.4.1 → 0.7.6 in ~3 months.        | Pin a compatible range per §27; re-verify `net.ts` and `raw_socket.rs` before PR 4 rather than trusting this document. |
| Port 9451 is reachable by any tailnet device.                   | Tailscale grant is mandatory (Appendix C); handshake timeout + default-deny matrix are the app perimeter.              |
| Per-chunk boundary cost — 16 MiB at 64 KiB is 256 native reads. | Measure in PR 2 against PERF-005. Mille's `FileReadStream` already runs this shape.                                    |
| 256-conn bridge cap is shared node-wide.                        | Keep §20.2 session caps; surface bridge-cap exhaustion as a distinct error rather than a generic dial failure.         |
| Shared host has global undo/projection/decorations.             | Deny remotely per §16.2; revisit with a WorkspaceEngine/ExplorerSession split later.                                   |

## Verification

- **PRs 1–3:** spec §24.1–24.3 against `PassThrough`; existing suite green
  (`cargo test --workspace --exclude mille-binding`, `pnpm -r --if-present test`); MessagePort
  benchmark within the 5% budget of NFR-002 / AC-010.
- **PRs 4–6:** §24.4–24.6, then the two-device tailnet procedure in AC-002 through AC-008, including
  an explicit test that an unauthorized tailnet device cannot distinguish an unknown export from a
  denied one.
