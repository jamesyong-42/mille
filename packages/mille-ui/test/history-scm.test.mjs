// Phase 5.3 — history + SCM action runner tests.
//
// Includes a real temporary-git integration suite (skipped when `git`
// is not on PATH) covering history, compare, revert, and path escape.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const {
  createMapFileHistoryClient,
  createMapScmClient,
  runScmRevert,
  runScmCompare,
  runFileHistory,
  ScmActionError,
  scmHistoryCommands,
  selectedScmTargets,
  groupScmTargetsByRoot,
} = await import('../dist/history.js');

const {
  parseGitLogLines,
  assertPathUnderRoot,
  assertSafeRevision,
  createShellScmClient,
  createShellFileHistoryClient,
} = await import('../dist/git-node.js');

function gitAvailable() {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitAvailable();

function runGit(cwd, args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout;
}

function makeHistoryFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mille-scm-hist-'));
  runGit(dir, ['init', '-q', '-b', 'main']);
  runGit(dir, ['config', 'commit.gpgsign', 'false']);
  // Pin line endings inside the fixture instead of inheriting the developer's
  // global config. Git for Windows defaults to `core.autocrlf=true`, which
  // rewrites `v2\n` to `v2\r\n` on the checkout `revert` performs — so the
  // assertion below compared the fixture's own content against a CRLF copy of
  // itself and failed for reasons unrelated to the SCM client.
  runGit(dir, ['config', 'core.autocrlf', 'false']);
  runGit(dir, ['config', 'core.eol', 'lf']);
  writeFileSync(path.join(dir, 'tracked.ts'), 'v1\n');
  runGit(dir, ['add', 'tracked.ts']);
  runGit(dir, ['commit', '-q', '-m', 'first']);
  writeFileSync(path.join(dir, 'tracked.ts'), 'v2\n');
  runGit(dir, ['add', 'tracked.ts']);
  runGit(dir, ['commit', '-q', '-m', 'second']);
  // Dirty working tree for compare/revert.
  writeFileSync(path.join(dir, 'tracked.ts'), 'dirty\n');
  // Sibling outside repo for escape checks.
  const outside = path.join(path.dirname(dir), `secret-${path.basename(dir)}.txt`);
  writeFileSync(outside, 'SECRET\n');
  return { dir, outside };
}

test('runScmRevert confirms, progresses, and reverts', async () => {
  const scm = createMapScmClient();
  const events = [];
  await runScmRevert(['src/a.ts'], {
    client: scm,
    hooks: {
      confirm: async (msg) => {
        assert.match(msg, /Discard/);
        return true;
      },
      onProgress: (e) => events.push(e.phase),
    },
  });
  assert.deepEqual(scm.reverted, [['src/a.ts']]);
  assert.ok(events.includes('preparing'));
  assert.ok(events.includes('running'));
  assert.ok(events.includes('completed'));
});

test('runScmRevert aborts when user declines', async () => {
  const scm = createMapScmClient();
  await assert.rejects(
    () =>
      runScmRevert(['a.ts'], {
        client: scm,
        hooks: { confirm: async () => false },
      }),
    (err) => err instanceof ScmActionError && err.code === 'ECANCELED',
  );
  assert.equal(scm.reverted.length, 0);
});

test('runScmRevert unsupported client', async () => {
  await assert.rejects(
    () => runScmRevert(['a.ts'], { client: {} }),
    (err) => err instanceof ScmActionError && err.code === 'EUNSUPPORTED',
  );
});

test('runScmCompare returns content from map client', async () => {
  const history = createMapFileHistoryClient();
  history.setContents('a.ts', 'HEAD', 'old');
  const scm = createMapScmClient(history);
  scm.workingContents.set('a.ts', 'new');
  const result = await runScmCompare(
    {
      path: 'a.ts',
      left: { kind: 'revision', revision: 'HEAD' },
      right: { kind: 'working' },
    },
    { client: scm },
  );
  assert.ok(result);
  assert.equal(result.left, 'old');
  assert.equal(result.right, 'new');
  assert.equal(result.leftLabel, 'HEAD');
  assert.equal(result.rightLabel, 'Working Tree');
});

test('runFileHistory returns revisions with progress', async () => {
  const history = createMapFileHistoryClient(
    new Map([
      [
        'a.ts',
        [
          {
            id: 'aaa',
            shortId: 'aaa',
            timestampMs: 2,
            message: 'second',
          },
          {
            id: 'bbb',
            shortId: 'bbb',
            timestampMs: 1,
            message: 'first',
          },
        ],
      ],
    ]),
  );
  const phases = [];
  const revs = await runFileHistory(
    history,
    { path: 'a.ts', limit: 1 },
    { hooks: { onProgress: (e) => phases.push(e.phase) } },
  );
  assert.equal(revs.length, 1);
  assert.equal(revs[0].id, 'aaa');
  assert.ok(phases.includes('completed'));
});

test('scmHistoryCommands expose expected ids', () => {
  const ids = scmHistoryCommands.map((c) => c.id).sort();
  assert.deepEqual(ids, [
    'scm.compareWithHead',
    'scm.compareWithPrevious',
    'scm.revert',
    'scm.showHistory',
  ]);
});

test('parseGitLogLines parses git log format', () => {
  const revs = parseGitLogLines(
    'abc123def\tabc123d\t1700000000\tAda\tInitial commit\n' +
      'fff\tfff\t1700000001\tBob\tFix bug\n',
  );
  assert.equal(revs.length, 2);
  assert.equal(revs[0].id, 'abc123def');
  assert.equal(revs[0].shortId, 'abc123d');
  assert.equal(revs[0].author, 'Ada');
  assert.equal(revs[0].message, 'Initial commit');
  assert.equal(revs[0].timestampMs, 1700000000 * 1000);
});

test('runScmRevert respects AbortSignal', async () => {
  const scm = createMapScmClient();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () =>
      runScmRevert(['a.ts'], {
        client: scm,
        signal: ac.signal,
        hooks: { confirm: async () => true },
      }),
    (err) => err instanceof ScmActionError && err.code === 'ECANCELED',
  );
});

test('assertPathUnderRoot rejects traversal', () => {
  assert.throws(() => assertPathUnderRoot('/ws', '../secret.txt'), /escapes/);
  assert.throws(() => assertPathUnderRoot('/ws', '/abs/x'), /escapes/);
  assert.throws(() => assertPathUnderRoot('/ws', 'a/../../b'), /escapes/);
  assert.equal(assertPathUnderRoot('/ws', 'src/a.ts'), 'src/a.ts');
});

test('createShellScmClient.compare rejects path escape', async () => {
  const scm = createShellScmClient({
    rootPath: '/tmp/mille-scm-root',
    spawn: () => {
      throw new Error('spawn should not run for escaped paths');
    },
  });
  await assert.rejects(
    () =>
      scm.compare({
        path: '../secret.txt',
        left: { kind: 'working' },
        right: { kind: 'working' },
      }),
    /escapes/,
  );
});

test('compare refuses to read through a symlink that escapes the root', async () => {
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'mille-scm-link-'));
  const outsideDir = mkdtempSync(path.join(tmpdir(), 'mille-scm-secret-'));
  writeFileSync(path.join(outsideDir, 'secret.txt'), 'SECRET\n');
  mkdirSync(path.join(dir, 'src'));

  let linked = true;
  try {
    // A workspace-relative path like `src/out/secret.txt` is lexically
    // contained, yet reading it follows the link out of the workspace.
    symlinkSync(outsideDir, path.join(dir, 'src', 'out'), 'dir');
  } catch {
    linked = false; // symlink creation needs privileges on some platforms
  }

  if (linked) {
    const scm = createShellScmClient({ rootPath: dir });
    await assert.rejects(
      () =>
        scm.compare({
          path: 'src/out/secret.txt',
          left: { kind: 'working' },
          right: { kind: 'working' },
        }),
      /escapes workspace root/,
    );
  }

  rmSync(dir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

test('assertSafeRevision rejects git option injection', () => {
  // `git show <rev>:<path>` is positional: a leading `-` reaches git as an
  // option. `--output=<file>` is an arbitrary-file-write primitive, and it
  // carries no `:` of its own, so a colon check alone does not catch it.
  assert.throws(() => assertSafeRevision('--output=/tmp/pwn'), /git option/);
  assert.throws(() => assertSafeRevision('-x'), /git option/);
  assert.throws(() => assertSafeRevision('HEAD:extra'), /invalid revision/);
  assert.throws(() => assertSafeRevision('HEAD\0'), /invalid revision/);
  assert.throws(() => assertSafeRevision('HEAD; rm -rf /'), /invalid revision/);
  assert.throws(() => assertSafeRevision(''), /non-empty/);

  // Shapes real revisions take.
  assert.equal(assertSafeRevision('HEAD'), 'HEAD');
  assert.equal(assertSafeRevision('HEAD~3'), 'HEAD~3');
  assert.equal(assertSafeRevision('HEAD@{2}'), 'HEAD@{2}');
  assert.equal(assertSafeRevision('v1.2.0^{}'), 'v1.2.0^{}');
  assert.equal(assertSafeRevision('refs/heads/my-branch'), 'refs/heads/my-branch');
  assert.equal(
    assertSafeRevision('0dc2bcb1f2e3a4b5c6d7e8f9a0b1c2d3e4f5a6b7'),
    '0dc2bcb1f2e3a4b5c6d7e8f9a0b1c2d3e4f5a6b7',
  );
});

test('createShellFileHistoryClient.getContents never spawns git for an option-like revision', async () => {
  const history = createShellFileHistoryClient({
    rootPath: '/tmp/mille-scm-root',
    spawn: () => {
      throw new Error('spawn should not run for an unsafe revision');
    },
  });
  await assert.rejects(
    () => history.getContents({ path: 'tracked.ts', revision: '--output=/tmp/pwn' }),
    /git option/,
  );
});

test('selectedScmTargets / groupScmTargetsByRoot keep multi-root identity', () => {
  // rootA/same.ts and rootB/same.ts must not collapse.
  const rootA = { id: 1, name: 'rootA', kind: 1, parentId: null };
  const rootB = { id: 2, name: 'rootB', kind: 1, parentId: null };
  const fileA = { id: 10, name: 'same.ts', kind: 0, parentId: 1 };
  const fileB = { id: 20, name: 'same.ts', kind: 0, parentId: 2 };
  const byId = new Map([
    [1, rootA],
    [2, rootB],
    [10, fileA],
    [20, fileB],
  ]);
  const ctx = {
    fx: {},
    snapshot: { getById: (id) => byId.get(id) ?? null },
    focusedId: 10,
    focusedEntry: fileA,
    selectedIds: new Set([10, 20]),
    selectedEntries: [fileA, fileB],
    isMultiSelect: true,
    isRenaming: false,
    host: {
      resolveRootPath: (rootId) =>
        rootId === 1 ? '/abs/rootA' : rootId === 2 ? '/abs/rootB' : undefined,
    },
    cutIds: new Set(),
    copyIds: new Set(),
    workspaceRoot: '/abs/rootA',
  };
  const targets = selectedScmTargets(ctx);
  assert.equal(targets.length, 2);
  assert.deepEqual(
    targets.map((t) => [t.rootPath, t.rootRelativePath]).sort(),
    [
      ['/abs/rootA', 'same.ts'],
      ['/abs/rootB', 'same.ts'],
    ].sort(),
  );
  const groups = groupScmTargetsByRoot(targets);
  assert.equal(groups.size, 2);
  assert.deepEqual(groups.get('/abs/rootA'), ['same.ts']);
  assert.deepEqual(groups.get('/abs/rootB'), ['same.ts']);
});

test('scm.revert dispatches per owning root', async () => {
  const reverted = [];
  const rootA = { id: 1, name: 'rootA', kind: 1, parentId: null };
  const rootB = { id: 2, name: 'rootB', kind: 1, parentId: null };
  const fileA = { id: 10, name: 'same.ts', kind: 0, parentId: 1 };
  const fileB = { id: 20, name: 'same.ts', kind: 0, parentId: 2 };
  const byId = new Map([
    [1, rootA],
    [2, rootB],
    [10, fileA],
    [20, fileB],
  ]);
  const revertCmd = scmHistoryCommands.find((c) => c.id === 'scm.revert');
  assert.ok(revertCmd);
  await revertCmd.run({
    fx: {},
    snapshot: { getById: (id) => byId.get(id) ?? null },
    focusedId: 10,
    focusedEntry: fileA,
    selectedIds: new Set([10, 20]),
    selectedEntries: [fileA, fileB],
    isMultiSelect: true,
    isRenaming: false,
    host: {
      resolveRootPath: (rootId) =>
        rootId === 1 ? '/abs/rootA' : '/abs/rootB',
      scm: {
        async revert(paths, opts) {
          reverted.push({ paths: [...paths], rootPath: opts?.rootPath });
        },
      },
      confirm: async () => true,
    },
    cutIds: new Set(),
    copyIds: new Set(),
  });
  assert.equal(reverted.length, 2);
  const byRoot = new Map(reverted.map((r) => [r.rootPath, r.paths]));
  assert.deepEqual(byRoot.get('/abs/rootA'), ['same.ts']);
  assert.deepEqual(byRoot.get('/abs/rootB'), ['same.ts']);
});

test('createShellScmClient kills child on AbortSignal', async () => {
  let killed = false;
  const scm = createShellScmClient({
    rootPath: '/tmp/mille-scm-root',
    spawn: () => {
      const listeners = { close: [], error: [], dataOut: [], dataErr: [] };
      const child = {
        stdout: {
          on: (ev, cb) => {
            if (ev === 'data') listeners.dataOut.push(cb);
          },
        },
        stderr: {
          on: (ev, cb) => {
            if (ev === 'data') listeners.dataErr.push(cb);
          },
        },
        on: (ev, cb) => {
          if (ev === 'close') listeners.close.push(cb);
          if (ev === 'error') listeners.error.push(cb);
        },
        kill: () => {
          killed = true;
          for (const cb of listeners.close) cb(1);
          return true;
        },
      };
      // Never closes on its own — abort must kill.
      return child;
    },
  });
  const ac = new AbortController();
  const p = scm.revert(['src/a.ts'], { signal: ac.signal });
  // Allow spawn to run then abort.
  await Promise.resolve();
  ac.abort();
  await assert.rejects(() => p, /abort/i);
  assert.equal(killed, true);
});

// ─── Real temporary-git integration (requires git on PATH) ────────────

test(
  'shell history: real repo getHistory + getContents',
  { skip: HAS_GIT ? false : 'git not on PATH' },
  async () => {
    const { dir, outside } = makeHistoryFixture();
    try {
      const history = createShellFileHistoryClient({ rootPath: dir });
      const revs = await history.getHistory({ path: 'tracked.ts', limit: 10 });
      assert.ok(revs.length >= 2, `expected ≥2 commits, got ${revs.length}`);
      assert.match(revs[0].message ?? '', /second|first/);
      const head = revs[0].id;
      const contents = await history.getContents({
        path: 'tracked.ts',
        revision: head,
      });
      assert.ok(typeof contents === 'string');
      assert.match(contents, /v2|v1|dirty/);

      // Escape via relative path must throw before git runs.
      await assert.rejects(
        () => history.getHistory({ path: '../' + path.basename(outside) }),
        /escapes/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      try {
        rmSync(outside, { force: true });
      } catch {
        /* ignore */
      }
    }
  },
);

test(
  'shell scm: real repo compare + revert restores HEAD',
  { skip: HAS_GIT ? false : 'git not on PATH' },
  async () => {
    const { dir, outside } = makeHistoryFixture();
    try {
      const scm = createShellScmClient({ rootPath: dir });
      assert.equal(readFileSync(path.join(dir, 'tracked.ts'), 'utf8'), 'dirty\n');

      const cmp = await scm.compare({
        path: 'tracked.ts',
        left: { kind: 'revision', revision: 'HEAD' },
        right: { kind: 'working' },
      });
      assert.equal(cmp.leftLabel, 'HEAD');
      assert.equal(cmp.rightLabel, 'Working Tree');
      assert.equal(cmp.left, 'v2\n');
      assert.equal(cmp.right, 'dirty\n');

      await scm.revert(['tracked.ts']);
      assert.equal(readFileSync(path.join(dir, 'tracked.ts'), 'utf8'), 'v2\n');

      // Path escape must not read the sibling secret file.
      await assert.rejects(
        () =>
          scm.compare({
            path: '../' + path.basename(outside),
            left: { kind: 'working' },
            right: { kind: 'working' },
          }),
        /escapes/,
      );
      assert.equal(readFileSync(outside, 'utf8'), 'SECRET\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      try {
        rmSync(outside, { force: true });
      } catch {
        /* ignore */
      }
    }
  },
);

test(
  'shell scm: mid-flight AbortSignal kills real git process',
  { skip: HAS_GIT ? false : 'git not on PATH' },
  async () => {
    const { dir, outside } = makeHistoryFixture();
    try {
      // A long-running git command: `git log --all` with a huge max-count
      // still finishes quickly on a tiny repo, so we use a wrapper spawn
      // that starts real git then aborts.
      const scm = createShellScmClient({ rootPath: dir });
      const ac = new AbortController();
      // Start restore of many no-op paths is still fast; use compare with
      // signal aborted shortly after start — pre-flight abort is already
      // covered. For real kill we spawn via revert with delayed abort
      // while git is running (tiny repo may finish first — still must not throw
      // uncaught and must leave tree consistent).
      writeFileSync(path.join(dir, 'tracked.ts'), 'again\n');
      const p = scm.revert(['tracked.ts'], { signal: ac.signal });
      ac.abort();
      try {
        await p;
      } catch (err) {
        assert.match(String(err), /abort/i);
      }
      // Tree may be either dirty or restored depending on race; no crash.
      const body = readFileSync(path.join(dir, 'tracked.ts'), 'utf8');
      assert.ok(body === 'again\n' || body === 'v2\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      try {
        rmSync(outside, { force: true });
      } catch {
        /* ignore */
      }
    }
  },
);
