# Acceptance procedure

The acceptance criteria for remote workspaces are `AC-001`…`AC-012` in
`draft/mille-truffle-spec.md` §25. They are outcomes, not steps. This is the
procedure.

Most criteria are covered by the ordinary test suite and need no network. Two
need a **real tailnet**, and one of those needs **two physical devices** —
that one cannot be discharged on a single machine, for reasons spelled out
below.

## Coverage map

| Criterion | Where it is checked | Needs |
| --------- | ------------------- | ----- |
| AC-001 existing tests unaffected | `pnpm -r --if-present test` | — |
| AC-002 client on device A browses device B | `tailnet-acceptance.mjs --role=server` / `--role=client` | **two devices** |
| AC-003 CRUD works / read-only refuses | `test/security.test.mjs`, acceptance script | — / tailnet |
| AC-004 changes arrive via the watcher | `test/watch.test.mjs` (5 cases), acceptance script | — / tailnet |
| AC-005 disconnect: stale snapshot, pending rejected | `test/client.test.mjs`, acceptance script | — / tailnet |
| AC-006 reconnect; restart emits `identityReset` | `test/client.test.mjs`, acceptance script | — / tailnet |
| AC-007 unauthorized peer learns nothing | `test/server.test.mjs`, acceptance script | — / tailnet |
| AC-008 traversal / symlink / junction escape | `test/security.test.mjs` (8 cases) | — |
| AC-009 bounds are demonstrated | `mille`'s `stream-codec` + `stream-channel` suites | — |
| AC-010 MessagePort regression < 5% | `node packages/mille/bench/viewport-retention.mjs`, before/after | — |
| AC-011 two clients, isolated state | `test/server.test.mjs`, acceptance script | — / tailnet |
| AC-012 docs cover setup, policy, failure, limits | `README.md` | — |

## One-time setup

1. Generate a Tailscale auth key at
   <https://login.tailscale.com/admin/settings/keys> with **Reusable**,
   **Ephemeral**, and tag `tag:truffle-test`. Add **Pre-approved** if your
   tailnet has device approval on.

2. Your tailnet ACL needs the tag declared and test nodes allowed to reach each
   other:

   ```jsonc
   {
     "tagOwners": { "tag:truffle-test": [] },
     "acls": [
       { "action": "accept", "src": ["tag:truffle-test"], "dst": ["tag:truffle-test:*"] },
     ],
   }
   ```

3. Put the key in `.env` at the repo root (gitignored):

   ```
   TRUFFLE_TEST_AUTHKEY=tskey-auth-...
   ```

   The script also reads it from the environment. It never prints the key —
   only its length, if anything.

4. Build first. The script imports `dist/`:

   ```bash
   pnpm install
   pnpm --filter @vibecook/mille run build:napi:debug
   pnpm --filter @vibecook/mille run build:ts
   pnpm --filter @vibecook/mille-truffle run build
   ```

## Single machine (fast, does **not** satisfy AC-002)

```bash
node packages/mille-truffle/acceptance/tailnet-acceptance.mjs --role=both
```

Two ephemeral mesh nodes in one process. This exercises the genuine sidecar,
WireGuard tunnel, bridge and framing path — everything except the network
between two hosts.

> **It does not satisfy AC-002.** Loopback cannot fail the way a real link
> can: no NAT traversal, no DERP relay, no wide-area latency or reordering, and
> both ends share a clock and a CPU. A green run here means the protocol and
> policy are right, not that two devices can talk. The JSON report records
> `satisfiesAC002: false` so a passing artifact cannot be mistaken for one.

## Two devices (satisfies AC-002)

On **device A** (the one with the files):

```bash
node packages/mille-truffle/acceptance/tailnet-acceptance.mjs --role=server
```

It prints its device name and the command to run. On **device B**:

```bash
node packages/mille-truffle/acceptance/tailnet-acceptance.mjs \
  --role=client --peer=<device-name-from-A>
```

Then Ctrl-C the server.

`--peer` accepts anything Truffle resolves: device name, device id, a ≥4-char
id prefix, or the `100.x` address.

### Run it from a console session, not over SSH

On Windows the client must be started from an interactive session — physical
console or RDP. Over SSH it dies before touching the network:

```
tsnet: NewLocalBackend: syspolicy: LocalBacked failed to register policy
change callback: failed to get a store reader: Access is denied.
```

This is not a UAC problem and elevating does not help: the failing session was
already `High Mandatory Level` with `BUILTIN\Administrators` enabled. What
differs is the logon type — an SSH session carries `NT AUTHORITY\NETWORK`, and
embedded tsnet cannot open the policy store under it on a host that is also
running the real Tailscale service. The same command, same machine, same user,
succeeds from the console.

Measured 2026-07-27: identical invocation failed over SSH and passed 7/7 from
the console.

### What the two-device run cannot check

`AC-004` and `AC-005`/`AC-006` need the *server's* filesystem touched and the
*server* restarted, which the client cannot do. The script says `SKIP` for
those rather than passing them silently. To cover them across two devices,
either run the `--role=both` mode as well (they are covered there), or drive
the server side by hand: create a file in the printed workspace directory and
watch it appear on the client, then Ctrl-C and restart the server and watch
`identityReset` fire.

## Options

| Flag | Default | Meaning |
| ---- | ------- | ------- |
| `--role=` | `both` | `both`, `server`, or `client` |
| `--peer=` | — | required for `--role=client` |
| `--port=` | `9451` | mesh port to serve/dial |
| `--app-id=` | `mille-accept` | Truffle app namespace; must match on both ends |
| `--export=` | `acceptance` | export id to serve/open |
| `--json=` | — | write a machine-readable report |
| `--run-id=` | random | suffix for device names |

Device names carry a per-run suffix on purpose: ephemeral nodes linger in the
netmap for a while after `stop()`, and without a unique name a later run can
resolve a stale entry and dial a dead address.

## AC-010: the MessagePort regression check

The channel abstraction sits in the local MessagePort path, so it has a budget.
Only `viewport-retention.mjs` exercises that path, and no Rust changed across
the remote-workspace work, so one native binary serves both measurements —
swap `packages/mille/src` and rebuild TypeScript only:

```bash
# after
node packages/mille/bench/viewport-retention.mjs

# before
git checkout <pre-refactor-commit> -- packages/mille/src packages/mille/api.d.ts
rm -rf packages/mille/src/channel packages/mille/src/stream packages/mille/src/node.ts \
       packages/mille/dist packages/mille/tsconfig.tsbuildinfo
pnpm --filter @vibecook/mille run build:ts
node packages/mille/bench/viewport-retention.mjs

# restore
git checkout HEAD -- packages/mille/src packages/mille/api.d.ts
rm -rf packages/mille/dist packages/mille/tsconfig.tsbuildinfo
pnpm --filter @vibecook/mille run build:ts
```

`git checkout <commit> -- <path>` does **not** delete files absent from that
commit, which is why `channel/`, `stream/` and `node.ts` are removed
explicitly — otherwise the "before" build still contains them.

Sample rather than trusting one run: the spread between repeats of the same
build is comparable to a 5% effect, so a single pair of numbers cannot tell a
regression from noise. Measured 2026-07-27 over 4 baseline and 5 post-refactor
runs, worst delta **+2.0%** against the 5% budget.

## Recording a result

Keep the JSON report with the release notes. It carries the run's role, Node
version, platform, per-criterion outcomes, and the `satisfiesAC002` flag.

## Result, 2026-07-27

First genuine two-device run. Server on macOS arm64, client on Windows x64
(Node 24.14.1), each with its own ephemeral tsnet node on a real tailnet.
**7/7**, connect in 52 ms. AC-004/005/006 reported `SKIP` as designed and are
covered by a `--role=both` run the same day, **14/14**.

The run also earned its keep by finding two defects that a one-machine run
cannot surface:

- **AC-007 raced the tailnet route.** It is the client's first action, so on a
  real link both dials failed in transport before reaching the server — which
  logged no `open_requested` at all — and the report blamed authorization for
  a refusal that never happened. The dials now retry through `TRANSPORT_ERROR`
  and say `inconclusive` if they still never land. Once through, the server
  refused `acceptance-locked` with `not on the export allow-list` and
  `no-such-export-at-all` with `no such export`, while the client saw one
  identical `access denied` for both — SEC-006 demonstrated rather than
  assumed.
- **`satisfiesAC002` ignored outcomes.** It was `role !== 'both'`, so a client
  that failed to start its node still stamped the criterion met. It is now
  gated on every check passing.
