// Regression — decoration refresh inside a linked worktree.
//
// A linked worktree's `.git` is a *file* holding `gitdir: <path>`, and
// both `HEAD` and `index` live at the far end of that redirect rather
// than anywhere under the worktree root. The watcher used to fall back
// to `path.dirname('<worktree>/.git')` — the worktree root itself —
// where those two files never appear, so `fs.watch` failed ENOENT on
// both, the directory watch only ever saw ordinary source files, and
// the filter rejected every one. Net effect: badges painted once from
// the initial `git status` (git resolves the redirect itself) and then
// froze forever, with no error anywhere.
//
// That silence is what makes it worth a dedicated test: nothing about
// the failure is observable except the absence of a callback, and the
// ordinary-repo path stays green throughout. The control case below
// runs the identical assertions against a normal repo so a future
// change that breaks *both* can't be mistaken for this one passing.
//
// Requires a real `git` binary; skips cleanly without one.

import { removeTempDir } from '../../../scripts/test-temp.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const { resolveGitDir, watchDotGit } = await import('../dist/git-node.js');

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

/**
 * A repo with one commit plus a linked worktree checked out on a new
 * branch. Returns both paths; the caller removes `base`, which holds
 * the two of them.
 */
function makeWorktreeFixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'mille-git-wt-'));
  const main = path.join(base, 'main-repo');
  const linked = path.join(base, 'linked');
  // `git init <dir>` creates it — no mkdir, which would need a shell
  // builtin this repo's Windows CI job doesn't have.
  runGit(base, ['init', '-q', '-b', 'main', 'main-repo']);
  runGit(main, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(main, 'hello.txt'), 'hello\n');
  runGit(main, ['add', 'hello.txt']);
  runGit(main, ['commit', '-q', '-m', 'init']);
  runGit(main, ['worktree', 'add', '-q', linked, '-b', 'feature']);
  return { base, main, linked };
}

/**
 * Attach a watcher, mutate the index, and report whether the debounced
 * `onChange` arrived inside `timeoutMs`.
 */
async function firesOnIndexMutation(dotGit, repoDir, timeoutMs = 3000) {
  let fired = 0;
  const dispose = watchDotGit(dotGit, () => {
    fired += 1;
  }, { debounceMs: 30 });
  try {
    // fs.watch registration races the first write on macOS FSEvents.
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(path.join(repoDir, 'hello.txt'), 'hello!!\n');
    runGit(repoDir, ['add', 'hello.txt']);
    const deadline = Date.now() + timeoutMs;
    while (fired === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return fired;
  } finally {
    dispose();
  }
}

test(
  'resolveGitDir: an ordinary .git directory resolves to itself',
  { skip: HAS_GIT ? false : 'git not on PATH' },
  async () => {
    const { base, main } = makeWorktreeFixture();
    try {
      const dotGit = path.join(main, '.git');
      assert.ok(statSync(dotGit).isDirectory(), 'fixture precondition: .git is a directory');
      assert.equal(resolveGitDir(dotGit), dotGit);
    } finally {
      removeTempDir(base);
    }
  },
);

test(
  "resolveGitDir: a worktree's .git file resolves to the real gitdir",
  { skip: HAS_GIT ? false : 'git not on PATH' },
  async () => {
    const { base, linked } = makeWorktreeFixture();
    try {
      const dotGit = path.join(linked, '.git');
      assert.ok(statSync(dotGit).isFile(), 'fixture precondition: worktree .git is a file');

      // git is the oracle — assert against what it reports rather than
      // re-deriving the layout, so this keeps holding if git ever moves
      // the per-worktree directory.
      const expected = runGit(linked, ['rev-parse', '--absolute-git-dir']).trim();
      const actual = resolveGitDir(dotGit);

      // realpath both: macOS temp dirs are /var -> /private/var symlinks
      // and git reports the resolved form.
      assert.equal(
        path.resolve(actual),
        path.resolve(expected),
        `resolveGitDir returned ${actual}, git says ${expected}`,
      );
    } finally {
      removeTempDir(base);
    }
  },
);

test(
  'resolveGitDir: unreadable or malformed entries return null, not a guess',
  { skip: HAS_GIT ? false : 'git not on PATH' },
  async () => {
    const { base } = makeWorktreeFixture();
    try {
      assert.equal(resolveGitDir(path.join(base, 'does-not-exist')), null);

      const bogus = path.join(base, 'bogus-dotgit');
      writeFileSync(bogus, 'not a gitdir pointer\n');
      assert.equal(resolveGitDir(bogus), null);
    } finally {
      removeTempDir(base);
    }
  },
);

test(
  'watchDotGit: control — fires on index mutation in an ordinary repo',
  { skip: HAS_GIT ? false : 'git not on PATH' },
  async () => {
    const { base, main } = makeWorktreeFixture();
    try {
      const fired = await firesOnIndexMutation(path.join(main, '.git'), main);
      assert.ok(fired >= 1, 'control repo must fire — if this fails the regression test proves nothing');
    } finally {
      removeTempDir(base);
    }
  },
);

test(
  'watchDotGit: fires on index mutation inside a linked worktree',
  { skip: HAS_GIT ? false : 'git not on PATH' },
  async () => {
    const { base, linked } = makeWorktreeFixture();
    try {
      const fired = await firesOnIndexMutation(path.join(linked, '.git'), linked);
      assert.ok(
        fired >= 1,
        'onChange must fire inside a linked worktree — the gitdir redirect was not followed',
      );
    } finally {
      removeTempDir(base);
    }
  },
);
