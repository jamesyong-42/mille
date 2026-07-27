// Two-device tailnet acceptance for @vibecook/mille-truffle.
//
// Runs the parts of SPEC §25 that need a real tailnet. Everything else is
// covered by the ordinary suite, which needs no network — see ACCEPTANCE.md
// for which criterion is checked where and why.
//
// Two modes:
//
//   --role=both     one machine, two ephemeral mesh nodes. Exercises the real
//                   sidecar, WireGuard and framing path. Does NOT satisfy
//                   AC-002, which wants two devices: loopback cannot fail the
//                   way NAT traversal, DERP relay or wide-area latency can.
//
//   --role=server   serve an export and wait. Run on machine A.
//   --role=client   connect to machine A and run the checks. Run on machine B.
//                   This pair is what AC-002 actually requires.
//
// Requires TRUFFLE_TEST_AUTHKEY in the environment or in a .env at the repo
// root. The key is never printed.
//
//   node packages/mille-truffle/acceptance/tailnet-acceptance.mjs --role=both
//
// Exits non-zero if any check fails. `--json <path>` writes a report.

import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

// ─── options ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const role = opt('role', 'both');
const port = Number(opt('port', '9451'));
const appId = opt('app-id', 'mille-accept');
const exportId = opt('export', 'acceptance');
const peerQuery = opt('peer', '');
const jsonPath = opt('json', '');
const runId = opt('run-id', randomUUID().slice(0, 6));

if (!['both', 'server', 'client'].includes(role)) {
  console.error(`unknown --role=${role} (expected both | server | client)`);
  process.exit(2);
}
if (role === 'client' && peerQuery === '') {
  console.error('--role=client requires --peer=<device name, id, or 100.x address>');
  process.exit(2);
}

// ─── auth key ───────────────────────────────────────────────────────────

function authKey() {
  if (process.env.TRUFFLE_TEST_AUTHKEY) return process.env.TRUFFLE_TEST_AUTHKEY.trim();
  const envFile = join(repoRoot, '.env');
  if (existsSync(envFile)) {
    const line = readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('TRUFFLE_TEST_AUTHKEY='));
    if (line) return line.slice('TRUFFLE_TEST_AUTHKEY='.length).trim();
  }
  return '';
}

const key = authKey();
if (key === '') {
  console.error(
    'TRUFFLE_TEST_AUTHKEY is not set.\n' +
      'Generate a Reusable + Ephemeral key tagged tag:truffle-test at\n' +
      '  https://login.tailscale.com/admin/settings/keys\n' +
      'then put it in .env at the repo root, or export it.',
  );
  process.exit(2);
}

// ─── imports (after the cheap failures) ─────────────────────────────────

const { serveMille, connectMille } = await import('../dist/index.js');
const { createMeshNode } = await import('@vibecook/truffle');

// ─── reporting ──────────────────────────────────────────────────────────

const checks = [];
const record = (criterion, name, passed, detail) => {
  checks.push({ criterion, name, passed, detail });
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  [${criterion}] ${name}${detail ? ` — ${detail}` : ''}`);
};
const ok = (c, n, d) => record(c, n, true, d);
const bad = (c, n, d) => record(c, n, false, d);

async function waitFor(fn, label, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== null && v !== undefined && v !== false) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mille-accept-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'README.md'), '# acceptance\n');
  // A sibling the export must never expose, reachable only if the boundary
  // leaks. Kept inside the temp dir so nothing real is at risk.
  const outside = mkdtempSync(join(tmpdir(), 'mille-accept-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'must not be reachable\n');
  return { dir, outside };
}

// ─── mesh helpers ───────────────────────────────────────────────────────

const stateRoot = mkdtempSync(join(tmpdir(), 'mille-accept-state-'));

async function meshNode(suffix, wsPort) {
  return createMeshNode({
    appId,
    deviceName: `${hostname().toLowerCase().replace(/[^a-z0-9-]/g, '')}-${suffix}-${runId}`,
    authKey: key,
    ephemeral: true,
    stateDir: join(stateRoot, suffix),
    wsPort,
  });
}

// ─── server side ────────────────────────────────────────────────────────

async function startServer(mesh, dir) {
  const server = await serveMille(mesh, {
    port,
    exports: {
      [exportId]: { label: 'Acceptance (read-write)', roots: [dir], access: 'read-write' },
      [`${exportId}-ro`]: { label: 'Acceptance (read-only)', roots: [dir], access: 'read-only' },
      [`${exportId}-locked`]: {
        label: 'Acceptance (nobody)',
        roots: [dir],
        access: 'read-only',
        // No peer can match this, so it stands in for "exists but forbidden".
        allowedPeerIds: ['nNOBODY0000000'],
      },
    },
    logger: {
      info: (e, f) => console.log(`  [srv] ${e}${f ? ' ' + JSON.stringify(f) : ''}`),
      warn: (e, f) => console.log(`  [srv:warn] ${e}${f ? ' ' + JSON.stringify(f) : ''}`),
    },
  });
  return server;
}

// ─── client side ────────────────────────────────────────────────────────

async function runClientChecks(mesh, peer, { dir, outside } = {}) {
  // AC-007 — a forbidden export and a nonexistent one must look identical.
  const forbidden = await connectMille(mesh, {
    peer,
    port,
    exportId: `${exportId}-locked`,
    reconnect: false,
  }).then(
    (r) => ({ err: null, remote: r }),
    (err) => ({ err, remote: null }),
  );
  const ghost = await connectMille(mesh, {
    peer,
    port,
    exportId: 'no-such-export-at-all',
    reconnect: false,
  }).then(
    (r) => ({ err: null, remote: r }),
    (err) => ({ err, remote: null }),
  );
  if (forbidden.remote) await forbidden.remote.close();
  if (ghost.remote) await ghost.remote.close();

  if (forbidden.err && ghost.err && forbidden.err.code === 'ACCESS_DENIED') {
    const same = forbidden.err.message === ghost.err.message;
    record(
      'AC-007',
      'forbidden and unknown exports are indistinguishable',
      same,
      same ? forbidden.err.message : `"${forbidden.err.message}" vs "${ghost.err.message}"`,
    );
  } else {
    bad('AC-007', 'unauthorized open refused', `forbidden=${forbidden.err?.code} ghost=${ghost.err?.code}`);
  }

  // AC-002 / AC-003 — browse and mutate a real export.
  const t0 = Date.now();
  const remote = await connectMille(mesh, {
    peer,
    port,
    exportId,
    access: 'read-write',
    clientName: `acceptance-${runId}`,
    reconnect: { minDelayMs: 300, maxDelayMs: 3000 },
  });
  ok('AC-002', 'connected to the remote export', `${Date.now() - t0}ms`);
  const instance = remote.workspaceInstanceId;

  try {
    await waitFor(() => remote.explorer.getSnapshot().roots()[0]?.id, 'roots');
    const rootId = remote.explorer.getSnapshot().roots()[0].id;
    await remote.explorer.setExpanded({ add: [rootId], remove: [] });
    remote.explorer.setViewport({ offset: 0, limit: 100, overscan: 8 });
    const expanded = new Set([rootId]);
    const rows = await waitFor(() => {
      const r = remote.explorer.getSnapshot().visibleRows({ offset: 0, limit: 100, expanded });
      return r.length > 1 ? r : null;
    }, 'expanded rows');
    ok('AC-002', 'browsed the remote tree', rows.map((r) => r.name).join(', '));

    // AC-003 — the full mutation set.
    const created = await remote.explorer.create(rootId, 'acceptance.txt', 0);
    const payload = new TextEncoder().encode('written from the client device\n');
    await remote.explorer.writeFile(created.id, payload);
    const readBack = new TextDecoder().decode(await remote.explorer.readFile(created.id));
    const renamed = await remote.explorer.rename(created.id, 'acceptance-renamed.txt');
    await remote.explorer.delete(renamed.id ?? created.id);
    record(
      'AC-003',
      'create / write / read / rename / delete on a read-write export',
      readBack === 'written from the client device\n',
      `${payload.byteLength} bytes round-tripped`,
    );

    // AC-004 — a change made on the *server* reaches this client. Only
    // possible in --role=both; a remote server cannot be poked from here.
    if (dir !== undefined) {
      const marker = `watched-${runId}.txt`;
      writeFileSync(join(dir, marker), 'touched on the serving machine\n');
      try {
        await waitFor(
          () =>
            remote.explorer
              .getSnapshot()
              .visibleRows({ offset: 0, limit: 200, expanded })
              .some((r) => r.name === marker),
          'server-side change to arrive',
          20_000,
        );
        ok('AC-004', 'server-side change arrived via the watcher');
      } catch (err) {
        bad('AC-004', 'server-side change arrived via the watcher', err.message);
      }
    } else {
      console.log('  SKIP  [AC-004] needs --role=both (cannot touch the remote filesystem)');
    }

    // AC-008 — the boundary holds over the real transport.
    const escapes = ['../secret.txt', '../../etc/passwd', outside ? join(outside, 'secret.txt') : '/etc/passwd'];
    const leaked = [];
    for (const attempt of escapes) {
      if ((await remote.explorer.resolvePath(attempt)) !== null) leaked.push(attempt);
    }
    record('AC-008', 'traversal attempts do not resolve', leaked.length === 0, leaked.join(', '));

    // AC-003 (negative) — the read-only export refuses writes.
    const ro = await connectMille(mesh, {
      peer,
      port,
      exportId: `${exportId}-ro`,
      access: 'read-only',
      reconnect: false,
    });
    try {
      await waitFor(() => ro.explorer.getSnapshot().roots()[0]?.id, 'ro roots');
      const roRoot = ro.explorer.getSnapshot().roots()[0].id;
      try {
        await ro.explorer.create(roRoot, 'nope.txt', 0);
        bad('AC-003', 'read-only export refuses writes', 'create succeeded');
      } catch (err) {
        record('AC-003', 'read-only export refuses writes', err.code === 'EROFS', err.code);
      }
    } finally {
      await ro.close();
    }

    // AC-011 — two clients on one host keep independent state.
    const second = await connectMille(mesh, {
      peer,
      port,
      exportId,
      access: 'read-write',
      reconnect: false,
    });
    try {
      await waitFor(() => second.explorer.getSnapshot().roots()[0]?.id, 'second client roots');
      const sameInstance = second.workspaceInstanceId === instance;
      // Second client has expanded nothing, so it must see fewer rows.
      const secondRows = second.explorer
        .getSnapshot()
        .visibleRows({ offset: 0, limit: 100, expanded: new Set() });
      const firstRows = remote.explorer
        .getSnapshot()
        .visibleRows({ offset: 0, limit: 100, expanded });
      record(
        'AC-011',
        'two clients share one host with independent expansion',
        sameInstance && secondRows.length < firstRows.length,
        `instance shared=${sameInstance}, rows ${secondRows.length} vs ${firstRows.length}`,
      );
    } finally {
      await second.close();
    }

    // AC-005 — the stale snapshot survives a drop.
    const rootCount = remote.getSnapshot().roots().length;
    return { remote, instance, rootCount };
  } catch (err) {
    bad('client', 'checks', err.message);
    await remote.close();
    throw err;
  }
}

// ─── run ────────────────────────────────────────────────────────────────

let serverMesh;
let clientMesh;
let server;
let fixtureDirs;

try {
  if (role === 'server' || role === 'both') {
    fixtureDirs = fixture();
    serverMesh = await meshNode('host', 9417);
    const info = serverMesh.getLocalInfo();
    server = await startServer(serverMesh, fixtureDirs.dir);
    console.log('');
    console.log(`  serving export "${exportId}" on mesh port ${server.port}`);
    console.log(`  device name : ${info.deviceName}`);
    console.log(`  workspace   : ${fixtureDirs.dir}`);
    console.log('');
    if (role === 'server') {
      console.log('  On the other device, run:');
      console.log(
        `    node packages/mille-truffle/acceptance/tailnet-acceptance.mjs \\\n` +
          `      --role=client --peer=${info.deviceName} --app-id=${appId} --export=${exportId}`,
      );
      console.log('');
      console.log('  Ctrl-C when the client has finished.');
      await new Promise(() => {}); // serve until interrupted
    }
  }

  if (role === 'client' || role === 'both') {
    clientMesh = await meshNode('peer', role === 'both' ? 9418 : 9417);

    // In `both` mode the target is the node we just started, so resolve it by
    // name; ephemeral nodes linger in the netmap after stop(), which is why
    // every device name carries a per-run suffix. In `client` mode the caller
    // supplied the query and Truffle resolves it.
    let peer = peerQuery;
    if (role === 'both') {
      const want = serverMesh.getLocalInfo().deviceName;
      const deadline = Date.now() + 60_000;
      let found = null;
      while (Date.now() < deadline && found === null) {
        const peers = await clientMesh.getPeers();
        found = peers.find((p) => p.deviceName === want || p.hostname?.includes(want)) ?? null;
        if (found === null) await new Promise((r) => setTimeout(r, 1000));
      }
      if (found === null) throw new Error(`peer ${want} never appeared on the tailnet`);
      console.log(`  resolved peer: ${found.hostname} (${found.ip})`);
      peer = found;
    }

    const { remote, instance, rootCount } = await runClientChecks(
      clientMesh,
      peer,
      role === 'both' ? fixtureDirs : {},
    );

    // AC-005 / AC-006 — drop and recover. Only --role=both can restart the
    // server; against a remote server this checks the drop only.
    try {
      if (role === 'both') {
        await server.close();
        await waitFor(() => remote.state !== 'online', 'client noticed the drop');
        ok('AC-005', 'drop detected', `state ${remote.state}`);
        record(
          'AC-005',
          'stale snapshot still readable',
          remote.getSnapshot().roots().length === rootCount,
        );
        try {
          remote.explorer;
          bad('AC-005', 'offline explorer access throws', 'it did not');
        } catch {
          ok('AC-005', 'offline explorer access throws');
        }

        server = await startServer(serverMesh, fixtureDirs.dir);
        const resets = [];
        remote.on('identityReset', (e) => resets.push(e));
        await waitFor(() => remote.state === 'online', 'reconnect', 40_000);
        ok('AC-006', 'reconnected automatically');
        const changed = remote.workspaceInstanceId !== instance;
        record(
          'AC-006',
          'a replaced host reports a new instance',
          changed,
          `${instance?.slice(0, 8)} -> ${remote.workspaceInstanceId?.slice(0, 8)}`,
        );
        await waitFor(() => remote.explorer.getSnapshot().roots().length > 0, 'tree after reconnect');
        ok('AC-006', 'tree usable after reconnect');
      } else {
        console.log('  SKIP  [AC-005/AC-006] restart the server device to exercise reconnect');
      }
    } finally {
      await remote.close();
    }
  }
} catch (err) {
  bad('run', role, err?.message ?? String(err));
  console.error(err);
} finally {
  try {
    if (server) await server.close();
  } catch {}
  try {
    if (clientMesh) await clientMesh.stop();
  } catch {}
  try {
    if (serverMesh) await serverMesh.stop();
  } catch {}
}

const failed = checks.filter((c) => !c.passed);
console.log('');
console.log(`  ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log('  failed:');
  for (const f of failed) console.log(`    [${f.criterion}] ${f.name} — ${f.detail ?? ''}`);
}

if (jsonPath !== '') {
  const covered = [...new Set(checks.map((c) => c.criterion))].sort();
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        role,
        runId,
        appId,
        exportId,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        // A one-machine run cannot speak for AC-002; say so in the artifact
        // rather than letting a green report imply otherwise.
        satisfiesAC002: role !== 'both',
        checks,
      },
      null,
      2,
    ),
  );
  console.log(`  report: ${jsonPath}`);
}

process.exit(failed.length === 0 ? 0 : 1);
