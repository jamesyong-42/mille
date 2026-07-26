// Phase B4.3 — integration tests for `createShellGitClient`.
//
// These tests require a real `git` binary on PATH. When git is
// unavailable (minimal CI images), each test skips so the suite stays
// green cross-platform.
//
// Coverage:
//   1. Parser-only: feed fake porcelain-v2 via `spawn` injection and
//      assert modified + untracked paths map correctly. Runs even
//      when git isn't installed — the real subprocess never spawns.
//   2. Real-repo smoke: tempdir → `git init` → commit → modify →
//      status. Asserts the client picks up `M` on the modified file
//      and an untracked marker on a new file.
//   3. Real-repo watcher: modifying the repo triggers `onChange`
//      (via fs.watch on `.git/index`).
//
// Absolute paths are used as map keys by `createShellGitClient`, so
// the assertions resolve each expected path the same way.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// v0.2 — shell client moved from `/git` to `/git/node` because it uses
// `node:child_process` and can't bundle into a renderer context; the
// renderer-safe `/git` barrel only exports types + the renderer-
// bundler-safe provider now.
const { createShellGitClient } = await import('../dist/git-node.js');

// ─── Git availability probe ──────────────────────────────────────────

function gitAvailable() {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitAvailable();

// ─── Parser-only test via injected fake spawn ────────────────────────

/**
 * Build a fake ChildProcessLike that pushes `stdoutBuf` into stdout,
 * emits `error` if `errorMsg` is provided, then emits `close(code)`.
 *
 * The streams are wired so that both stdout and stderr finish fully
 * before the `close` event fires — matches real child-process
 * semantics, and means `collectChild` sees the whole buffer.
 */
function fakeChild({ stdout = '', stderr = '', code = 0, errorMsg = null } = {}) {
  const outStream = Readable.from([Buffer.from(stdout)]);
  const errStream = Readable.from([Buffer.from(stderr)]);
  const emitter = new EventEmitter();
  let outDone = false;
  let errDone = false;
  function maybeClose() {
    if (!outDone || !errDone) return;
    if (errorMsg !== null) emitter.emit('error', new Error(errorMsg));
    emitter.emit('close', code);
  }
  outStream.on('end', () => { outDone = true; maybeClose(); });
  errStream.on('end', () => { errDone = true; maybeClose(); });
  return {
    stdout: outStream,
    stderr: errStream,
    on: (event, cb) => emitter.on(event, cb),
  };
}

test('createShellGitClient: parses porcelain v2 -z output with injected spawn', async () => {
  // Hand-crafted porcelain v2 -z output:
  //  - `1 .M N... src/a.ts` — worktree-modified
  //  - `1 M. N... src/b.ts` — staged-modified
  //  - `? untracked.txt`    — untracked
  //  - `! .vite/cache`      — ignored (must be skipped)
  //  - `2 R. N... rc50 new/path\tsrc/old.ts` — rename (the `\t` is
  //    inside the newPath field; the orig-path is the next NUL token.
  //    Our parser emits under the new path.)
  //
  // The fields between XY and path are: sub mH mI mW hH hI [rc].
  // Values are placeholders; the parser only cares about the XY pair
  // and the trailing path.
  const lines = [
    '1 .M N... 100644 100644 100644 0000000 0000000 src/a.ts',
    '1 M. N... 100644 100644 100644 0000000 0000000 src/b.ts',
    '? untracked.txt',
    '! .vite/cache',
    '2 R. N... 100644 100644 100644 0000000 0000000 R100 new/path.ts',
    'src/old.ts', // rename orig-path — consumed by the `2` entry above
  ];
  const stdout = lines.join('\0') + '\0';

  const warns = [];
  const ROOT = '/fake/root';
  const client = createShellGitClient({
    rootPath: ROOT,
    disableWatcher: true,
    spawn: () => fakeChild({ stdout, code: 0 }),
    warn: (m) => warns.push(m),
  });

  const status = await client.getStatus(ROOT);

  // The client keys the map by `path.resolve(rootPath, gitRelativePath)`, so
  // build the expectations the same way rather than hardcoding POSIX strings:
  // on Windows `path.resolve('/fake/root', 'src/a.ts')` is
  // `D:\fake\root\src\a.ts`, which the literals below could never match.
  // Git always reports its paths with forward slashes, hence the split.
  const at = (rel) => path.resolve(ROOT, ...rel.split('/'));

  // Unordered: four entries expected — skipped ignored line.
  const keys = [...status.keys()].sort();
  assert.deepEqual(
    keys,
    ['new/path.ts', 'src/a.ts', 'src/b.ts', 'untracked.txt'].map(at).sort(),
    `unexpected keys: ${JSON.stringify(keys)}`,
  );

  const a = status.get(at('src/a.ts'));
  assert.ok(a);
  assert.equal(a.status, 'M');
  assert.equal(a.staged, false);

  const b = status.get(at('src/b.ts'));
  assert.ok(b);
  assert.equal(b.status, 'M');
  assert.equal(b.staged, true);

  const u = status.get(at('untracked.txt'));
  assert.ok(u);
  assert.equal(u.status, '?');

  const r = status.get(at('new/path.ts'));
  assert.ok(r);
  assert.equal(r.status, 'R');
  assert.equal(r.staged, true);

  // No warnings on a well-formed payload.
  assert.equal(warns.length, 0, `unexpected warns: ${warns.join(' | ')}`);
});

test('createShellGitClient: exit 128 (non-repo) returns empty map silently', async () => {
  const warns = [];
  const client = createShellGitClient({
    rootPath: '/fake/root',
    disableWatcher: true,
    spawn: () => fakeChild({ stdout: '', stderr: 'not a git repo', code: 128 }),
    warn: (m) => warns.push(m),
  });
  const status = await client.getStatus('/fake/root');
  assert.equal(status.size, 0);
  assert.equal(warns.length, 0, 'exit 128 must not warn');
});

test('createShellGitClient: non-zero exit (other than 128) warns + empty map', async () => {
  const warns = [];
  const client = createShellGitClient({
    rootPath: '/fake/root',
    disableWatcher: true,
    spawn: () => fakeChild({ stdout: '', stderr: 'bad things', code: 2 }),
    warn: (m) => warns.push(m),
  });
  const status = await client.getStatus('/fake/root');
  assert.equal(status.size, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /exit 2/);
});

// ─── Real-repo fixture tests ─────────────────────────────────────────

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

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mille-git-'));
  runGit(dir, ['init', '-q', '-b', 'main']);
  runGit(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
  runGit(dir, ['add', 'hello.txt']);
  runGit(dir, ['commit', '-q', '-m', 'init']);
  // Dirty the repo.
  writeFileSync(path.join(dir, 'hello.txt'), 'hello!\n');
  writeFileSync(path.join(dir, 'untracked.txt'), 'new\n');
  return dir;
}

test(
  'createShellGitClient: real-repo getStatus returns M + untracked',
  { skip: HAS_GIT ? false : 'git not on PATH' },
  async () => {
    const dir = makeFixture();
    try {
      const client = createShellGitClient({
        rootPath: dir,
        // Leave watcher enabled so the watcher-test below can reuse
        // behaviour; the test finishes cleanly either way.
        disableWatcher: true,
      });

      const status = await client.getStatus(dir);
      const helloAbs = path.resolve(dir, 'hello.txt');
      const untrackedAbs = path.resolve(dir, 'untracked.txt');

      const hello = status.get(helloAbs);
      assert.ok(hello, `hello.txt missing in status; got ${[...status.keys()].join(', ')}`);
      assert.equal(hello.status, 'M');

      const untracked = status.get(untrackedAbs);
      assert.ok(untracked, 'untracked.txt must appear with ? status');
      assert.equal(untracked.status, '?');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);

test(
  'createShellGitClient: onChange fires when .git/index mutates',
  { skip: HAS_GIT ? false : 'git not on PATH' },
  async () => {
    const dir = makeFixture();
    const client = createShellGitClient({
      rootPath: dir,
      watchDebounceMs: 30,
    });
    try {
      // Verify the watcher target exists (it should after the init
      // commit created an index).
      assert.ok(existsSync(path.join(dir, '.git', 'index')), '.git/index must exist');

      let fired = 0;
      const unsub = client.onChange(() => { fired += 1; });

      // Give fs.watch a beat to initialize before we mutate. On macOS
      // FSEvents occasionally misses the first change if the watcher
      // registration is racing with the write.
      await new Promise((r) => setTimeout(r, 100));

      // Mutate index via `git add`. Bump hello.txt to a new content so
      // git actually rewrites the index (add-no-op otherwise).
      writeFileSync(path.join(dir, 'hello.txt'), 'hello!!\n');
      runGit(dir, ['add', 'hello.txt']);

      // Wait up to 2s for the debounced firing.
      const deadline = Date.now() + 2000;
      while (fired === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }

      assert.ok(fired >= 1, 'onChange must fire on index mutation');
      unsub();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
