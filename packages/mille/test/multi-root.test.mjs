import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';

import {
  connectFileExplorer,
  createFileExplorerHost,
  DEFAULT_EXPLORER_SETTINGS,
  FileExplorer,
} from '../dist/index.js';

function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-multi-root-'));
  const left = join(sandbox, 'left', 'workspace');
  const right = join(sandbox, 'right', 'workspace');
  mkdirSync(left, { recursive: true });
  mkdirSync(right, { recursive: true });
  writeFileSync(join(left, 'marker.txt'), 'left');
  writeFileSync(join(right, 'marker.txt'), 'right');
  return { sandbox, left, right };
}

const settings = {
  ...DEFAULT_EXPLORER_SETTINGS,
  compactFolders: false,
};

test('same-basename roots route URI lookup, reads, prefetch, and creates by identity', async () => {
  const { sandbox, left, right } = fixture();
  const fx = new FileExplorer({ roots: [left, right], settings });
  try {
    await fx.populateFromRoots();
    assert.deepEqual(
      fx
        .getSnapshot()
        .roots()
        .map((root) => root.name),
      ['workspace', 'workspace'],
    );

    const leftRoot = await fx.getByUri({ scheme: 'file', path: left });
    const rightRoot = await fx.getByUri({ scheme: 'file', path: right });
    const leftMarker = await fx.getByUri({ scheme: 'file', path: join(left, 'marker.txt') });
    const rightMarker = await fx.getByUri({ scheme: 'file', path: join(right, 'marker.txt') });
    assert.ok(leftRoot && rightRoot && leftMarker && rightMarker);
    assert.notEqual(leftRoot.id, rightRoot.id);
    assert.notEqual(leftMarker.id, rightMarker.id);
    assert.equal(await fx.readText(leftMarker.id), 'left');
    assert.equal(await fx.readText(rightMarker.id), 'right');

    await fx.prefetch(rightRoot.id, { depth: 1 });
    const created = await fx.create(rightRoot.id, 'right-only.txt', 0);
    assert.equal(created.parentId, rightRoot.id);
    assert.equal(existsSync(join(right, 'right-only.txt')), true);
    assert.equal(existsSync(join(left, 'right-only.txt')), false);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('same-basename absolute paths resolve to distinct identities through a port', async () => {
  const { sandbox, left, right } = fixture();
  const host = await createFileExplorerHost({ roots: [left, right], settings });
  await host.local.populateFromRoots();
  const channel = new MessageChannel();
  host.attachPort(channel.port1);
  const client = await connectFileExplorer(channel.port2);
  try {
    const leftId = await client.resolvePath(join(left, 'marker.txt'));
    const rightId = await client.resolvePath(join(right, 'marker.txt'));
    assert.ok(leftId !== null && rightId !== null);
    assert.notEqual(leftId, rightId);
    assert.equal(await client.readText(leftId), 'left');
    assert.equal(await client.readText(rightId), 'right');
    assert.deepEqual(
      client
        .getSnapshot()
        .roots()
        .map((root) => root.name),
      ['workspace', 'workspace'],
    );
  } finally {
    await client.dispose();
    await host.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
