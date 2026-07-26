import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const settings = {
  ...DEFAULT_EXPLORER_SETTINGS,
  compactFolders: false,
};

function fixture(fileCount = 64) {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-transfer-progress-'));
  const workspace = join(sandbox, 'workspace');
  const external = join(sandbox, 'external');
  mkdirSync(join(workspace, 'inbox'), { recursive: true });
  mkdirSync(join(external, 'bundle'), { recursive: true });
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(join(external, 'bundle', `f-${String(i).padStart(3, '0')}.txt`), `p${i}`);
  }
  return { sandbox, workspace, external, fileCount };
}

async function idAt(fx, path) {
  const id = await fx.resolvePath(path);
  assert.ok(id !== null, `expected path ${path}`);
  return id;
}

function parseDetail(detail) {
  assert.equal(typeof detail, 'string');
  return JSON.parse(detail);
}

test('copyFromPath emits OP_PROGRESS and OP_COMPLETE for recursive imports', async () => {
  const { sandbox, workspace, external, fileCount } = fixture(48);
  const fx = new FileExplorer({ roots: [workspace], settings, watchDebounceMs: 60_000 });
  const progress = [];
  const completes = [];
  const sub = fx.on('warning', (payload) => {
    if (payload?.code === 'OP_PROGRESS') progress.push(parseDetail(payload.detail));
    if (payload?.code === 'OP_COMPLETE') completes.push(parseDetail(payload.detail));
  });
  try {
    await fx.populateFromRoots();
    const inbox = await idAt(fx, join(workspace, 'inbox'));
    const imported = await fx.copyFromPath(join(external, 'bundle'), inbox, undefined, {
      operationId: 'op-import-1',
      reportProgress: true,
    });
    assert.equal(imported.name, 'bundle');
    assert.ok(progress.length >= 1, 'expected at least one progress event');
    assert.equal(progress[0].operationId, 'op-import-1');
    assert.ok(progress.every((p) => p.operationId === 'op-import-1'));
    assert.equal(completes.length, 1);
    assert.equal(completes[0].status, 'completed');
    assert.ok(completes[0].done >= fileCount);
    assert.equal(
      readFileSync(join(workspace, 'inbox', 'bundle', 'f-000.txt'), 'utf8'),
      'p0',
    );
  } finally {
    sub.dispose();
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('cancelOperation aborts an in-flight recursive copy with cleanup', async () => {
  const { sandbox, workspace, external } = fixture(400);
  const fx = new FileExplorer({ roots: [workspace], settings, watchDebounceMs: 60_000 });
  const cancels = [];
  const sub = fx.on('warning', (payload) => {
    if (payload?.code === 'OP_CANCELLED') cancels.push(parseDetail(payload.detail));
  });
  try {
    await fx.populateFromRoots();
    const inbox = await idAt(fx, join(workspace, 'inbox'));
    const operationId = 'op-cancel-me';
    // Cancel from the first progress event so the tree is only partially written.
    let cancelled = false;
    const progressSub = fx.on('warning', (payload) => {
      if (payload?.code === 'OP_PROGRESS' && !cancelled) {
        cancelled = true;
        assert.equal(fx.cancelOperation(operationId), true);
      }
    });
    try {
      await assert.rejects(
        fx.copyFromPath(join(external, 'bundle'), inbox, 'partial', {
          operationId,
          reportProgress: true,
        }),
        (error) => error?.code === 'ECANCELED',
      );
    } finally {
      progressSub.dispose();
    }
    assert.ok(cancels.length >= 1, 'expected OP_CANCELLED warning');
    assert.equal(cancels[0].status, 'cancelled');
    // Partial destination should be cleaned up for non-merge create paths.
    // Depending on timing, the folder may be gone or incomplete — never a
    // fully successful import of all 400 files.
    const fullMarker = join(workspace, 'inbox', 'partial', 'f-399.txt');
    // If cleanup removed the tree, good. If not, the last file of a full
    // copy must not exist.
    assert.equal(
      existsSync(fullMarker),
      false,
      'cancelled copy must not finish the full tree',
    );
  } finally {
    sub.dispose();
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('AbortSignal cancels copyFromPath via generated operation id', async () => {
  const { sandbox, workspace, external } = fixture(400);
  const fx = new FileExplorer({ roots: [workspace], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const inbox = await idAt(fx, join(workspace, 'inbox'));
    const controller = new AbortController();
    let aborted = false;
    const progressSub = fx.on('warning', (payload) => {
      if (payload?.code === 'OP_PROGRESS' && !aborted) {
        aborted = true;
        controller.abort();
      }
    });
    try {
      await assert.rejects(
        fx.copyFromPath(join(external, 'bundle'), inbox, 'aborted', {
          signal: controller.signal,
          reportProgress: true,
        }),
        (error) => error?.code === 'ECANCELED',
      );
    } finally {
      progressSub.dispose();
    }
    assert.equal(aborted, true, 'expected progress before abort');
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
