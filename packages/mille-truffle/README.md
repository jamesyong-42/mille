# @vibecook/mille-truffle

Serve a [mille](https://www.npmjs.com/package/@vibecook/mille) workspace to another
device on your tailnet, over [Truffle](https://github.com/vibecook-dev/truffle).

> **Experimental.** Server and client are both implemented. Not yet published.

## What it does

The native explorer runs on the machine that owns the files. A client on
another tailnet device gets the same `FileExplorer` surface it uses locally —
the existing host/client mirror protocol is simply carried over a Truffle
socket instead of a MessagePort. There is no per-file network RPC: expanding
a directory costs one control message, not one request per child.

## Usage

```ts
import { createMeshNode } from '@vibecook/truffle';
import { serveMille } from '@vibecook/mille-truffle';

const mesh = await createMeshNode({ appId: 'my-ide', deviceName: 'workshop' });

const server = await serveMille(mesh, {
  port: 9451,
  exports: {
    mille: {
      label: 'Mille repository',
      roots: ['/home/james/projects/mille'],
      access: 'read-write',
    },
  },
  authorize: ({ peerId, exportId, requestedAccess }) =>
    policy.allows(peerId, exportId, requestedAccess),
});
```

The mesh node is **borrowed**. Closing the server never stops it.

### Connecting

```ts
import { connectMille } from '@vibecook/mille-truffle';

const remote = await connectMille(mesh, {
  peer,
  exportId: 'mille',
  access: 'read-write',
  reconnect: {},
});

const rows = remote.explorer.getSnapshot().visibleRows({ offset: 0, limit: 50, expanded });
```

`remote.explorer` is the live session and throws when offline.
`remote.getSnapshot()` does not — it keeps returning the last tree while the
connection is gone, because a stale tree beats a blank one.

Mutations are **never replayed** across a reconnect. A write that did not
return a result frame did not happen; re-issuing it could duplicate a rename
or clobber a file changed in the interim.

Listen for `identityReset` if you persist `EntryId`s. It fires when the peer
comes back to a *different* host instance, which means every id you hold now
means nothing — resolve paths again instead.

## Security

Read this part.

**A raw Truffle TCP listener is tailnet-authenticated but application-
unauthenticated.** Any device on your tailnet can reach port 9451, regardless
of which app it belongs to — unlike Truffle's envelope layer, there is no
`app_id` check on `mesh.net`. Your `authorize` callback and a Tailscale grant
are the only things standing in front of the export.

So the Tailscale grant is **required, not advisory**:

```jsonc
{
  "grants": [
    { "src": ["group:developers"], "dst": ["tag:mille-host"], "ip": ["tcp:9451"] },
  ],
}
```

Other properties worth knowing:

- **`peerId` is a Tailscale stable node id**, taken from the accepted socket's
  WhoIs identity. It is not the client's self-declared device id, and
  `allowedPeerIds` matches against it. A socket with no verified identity is
  refused.
- **An unknown export and a forbidden one give the same answer.** Otherwise
  the service enumerates its own exports. Set `diagnosticDisclosure: true` to
  see the real reason in the reply while debugging.
- **No host, engine, or filesystem handle exists until authorization passes.**
- **Remote sessions are denied host-global operations** — undo, projection
  settings, workspace roots, workspace resync, `copyFromPath`, and client
  decorations — because those change what every other session sees.
- **Symlinks are not followed** on a remote export; `followSymlinks` must be
  `false` and defaults to it.
- Roots are canonicalized once at startup. Clients name an export, never a
  path.

## Operational notes

- **The heartbeat is load-bearing.** Truffle's sidecar reaps bridged
  connections after ~10 minutes idle, so a quiet workspace would silently die
  without it. Defaults: ping after 20 s of silence, close after 60 s with no
  inbound frame.
- Truffle's bridge caps **256 concurrent TCP connections node-wide**, shared
  with everything else using that mesh node. The per-export (16) and per-peer
  (4) session caps sit inside that budget.
- A host stays warm for `hostIdleTimeoutMs` (default 5 min) after its last
  session, so a reconnect within the lease keeps the same `EntryId`s.
- Served exports default to `initialWalk: 'roots-only'` — roots are seeded and
  children arrive on expand, which is the right shape for a large remote tree.
