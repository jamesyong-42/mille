import { strict as assert } from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { buildIdentity, DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const files = Number(process.env.MILLE_COPY_FROM_PATH_FILES ?? 256);
const samples = Number(process.env.MILLE_COPY_FROM_PATH_SAMPLES ?? 20);
const warmups = Number(process.env.MILLE_COPY_FROM_PATH_WARMUPS ?? 3);
const fileP95BudgetMs = Number(process.env.MILLE_COPY_FROM_PATH_FILE_P95_BUDGET_MS ?? 50);
const dirP95BudgetMs = Number(process.env.MILLE_COPY_FROM_PATH_DIR_P95_BUDGET_MS ?? 200);

const sandbox = mkdtempSync(join(tmpdir(), 'mille-copy-from-path-bench-'));
const workspace = join(sandbox, 'workspace');
const external = join(sandbox, 'external');
const bundle = join(external, 'bundle');
mkdirSync(workspace, { recursive: true });
mkdirSync(bundle, { recursive: true });
for (let index = 0; index < files; index += 1) {
  writeFileSync(
    join(bundle, `file-${String(index).padStart(4, '0')}.txt`),
    `payload-${index}\n`,
  );
}
writeFileSync(join(external, 'single.txt'), 'solo-payload');

const fx = new FileExplorer({
  roots: [workspace],
  settings: { ...DEFAULT_EXPLORER_SETTINGS, compactFolders: false },
  watchDebounceMs: 60_000,
});

function percentile(values, p) {
  return values[Math.min(values.length - 1, Math.floor(values.length * p))];
}

function summarize(values) {
  values.sort((a, b) => a - b);
  return {
    medianMs: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(values.at(-1).toFixed(3)),
  };
}

try {
  await fx.populateFromRoots();
  const rootId = await fx.resolvePath(workspace);
  assert.ok(rootId !== null);

  const fileTimings = [];
  const dirTimings = [];

  for (let sample = 0; sample < samples + warmups; sample += 1) {
    // Fresh parent per sample so growth of previous imports does not dominate.
    const inboxName = `inbox-${sample}`;
    const inboxPath = join(workspace, inboxName);
    mkdirSync(inboxPath, { recursive: true });
    await fx.resync(rootId, { recursive: false });
    const inboxId = await fx.resolvePath(inboxPath);
    assert.ok(inboxId !== null);

    const fileName = `single.txt`;
    const startedFile = performance.now();
    const fileEntry = await fx.copyFromPath(join(external, 'single.txt'), inboxId, fileName);
    const fileElapsed = performance.now() - startedFile;
    assert.equal(fileEntry.name, fileName);
    assert.equal(readFileSync(join(inboxPath, fileName), 'utf8'), 'solo-payload');
    if (sample >= warmups) fileTimings.push(fileElapsed);

    const dirName = `bundle`;
    const startedDir = performance.now();
    const dirEntry = await fx.copyFromPath(bundle, inboxId, dirName);
    const dirElapsed = performance.now() - startedDir;
    assert.equal(dirEntry.name, dirName);
    assert.equal(readFileSync(join(inboxPath, dirName, 'file-0000.txt'), 'utf8'), 'payload-0\n');
    if (sample >= warmups) dirTimings.push(dirElapsed);
  }

  const result = {
    identity: buildIdentity(),
    files,
    samples,
    file: summarize(fileTimings),
    directory: summarize(dirTimings),
    fileP95BudgetMs,
    dirP95BudgetMs,
  };
  console.log(JSON.stringify(result));
  assert.ok(
    result.file.p95Ms <= fileP95BudgetMs,
    `copyFromPath file p95 ${result.file.p95Ms}ms > ${fileP95BudgetMs}ms`,
  );
  assert.ok(
    result.directory.p95Ms <= dirP95BudgetMs,
    `copyFromPath directory p95 ${result.directory.p95Ms}ms > ${dirP95BudgetMs}ms`,
  );
} finally {
  await fx.dispose();
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
