// Phase 5.3 — history + SCM action runner tests.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const {
  createMapFileHistoryClient,
  createMapScmClient,
  runScmRevert,
  runScmCompare,
  runFileHistory,
  ScmActionError,
  scmHistoryCommands,
} = await import('../dist/history.js');

const { parseGitLogLines } = await import('../dist/git-node.js');

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
