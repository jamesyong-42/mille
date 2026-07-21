#!/usr/bin/env node

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { seedReferenceTree } from './watch-bench-lib.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const playgroundDir = dirname(scriptDir);
const repoRoot = dirname(dirname(playgroundDir));

function readNumber(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} requires a non-negative number`);
  return value;
}

function readString(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    `Usage: pnpm bench:watch -- [options]\n\nOptions:\n  --operations N         File operations to execute (default 240)\n  --seed-files N         Deterministic files present before watching (default 0)\n  --debounce MS          Native watcher debounce (default 40)\n  --timeout MS           Per-operation convergence timeout (default 5000)\n  --pause MS             Extra pause after each observed paint (default 0)\n  --max-paint-p95 MS     Maximum paint-ready p95 (default 150)\n  --max-react-p95 MS     Maximum React render-duration p95 (default 25)\n  --max-frame MS         Maximum sampled frame interval (default 50)\n  --report PATH          Preserve the JSON report at a stable path\n  --keep                 Preserve the temporary sandbox after exit\n  --exit                 Close the playground after completion\n`,
  );
  process.exit(0);
}

const operations = Math.max(1, Math.floor(readNumber(args, '--operations', 240)));
const seedFiles = Math.floor(readNumber(args, '--seed-files', 0));
const debounceMs = Math.floor(readNumber(args, '--debounce', 40));
const timeoutMs = Math.max(100, Math.floor(readNumber(args, '--timeout', 5_000)));
const pauseMs = Math.floor(readNumber(args, '--pause', 0));
const maxPaintP95Ms = readNumber(args, '--max-paint-p95', 150);
const maxReactP95Ms = readNumber(args, '--max-react-p95', 25);
const maxFrameIntervalMs = readNumber(args, '--max-frame', 50);
const keep = args.includes('--keep');
const exitOnComplete = args.includes('--exit');

const sandboxBase = await mkdtemp(join(tmpdir(), 'mille-playground-watch-bench-'));
const workspaceRoot = join(sandboxBase, 'workspace');
const requestedReportPath = readString(args, '--report');
const reportPath = requestedReportPath
  ? resolve(process.cwd(), requestedReportPath)
  : join(sandboxBase, 'watch-bench-report.json');
await mkdir(workspaceRoot);
await mkdir(dirname(reportPath), { recursive: true });
const reference = await seedReferenceTree(workspaceRoot, seedFiles);

const binary = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite',
);
console.log(`[mille watch bench] sandbox: ${workspaceRoot}`);
console.log(`[mille watch bench] report:  ${reportPath}`);
console.log(
  `[mille watch bench] operations=${operations} reference=${reference.entries} entries ` +
    `debounce=${debounceMs}ms timeout=${timeoutMs}ms`,
);
console.log('[mille watch bench] close the playground or press Ctrl+C to stop');

const child = spawn(binary, ['dev'], {
  cwd: playgroundDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    WORKSPACE_ROOT: workspaceRoot,
    MILLE_WATCH_BENCH: '1',
    MILLE_WATCH_BENCH_ROOT: workspaceRoot,
    MILLE_WATCH_BENCH_REPORT: reportPath,
    MILLE_WATCH_BENCH_OPERATIONS: String(operations),
    MILLE_WATCH_BENCH_SEED_FILES: String(seedFiles),
    MILLE_WATCH_BENCH_DEBOUNCE_MS: String(debounceMs),
    MILLE_WATCH_BENCH_TIMEOUT_MS: String(timeoutMs),
    MILLE_WATCH_BENCH_PAUSE_MS: String(pauseMs),
    MILLE_WATCH_BENCH_MAX_PAINT_P95_MS: String(maxPaintP95Ms),
    MILLE_WATCH_BENCH_MAX_REACT_P95_MS: String(maxReactP95Ms),
    MILLE_WATCH_BENCH_MAX_FRAME_INTERVAL_MS: String(maxFrameIntervalMs),
    MILLE_WATCH_BENCH_EXIT_ON_COMPLETE: exitOnComplete ? '1' : '0',
  },
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  if (keep) {
    console.log(`[mille watch bench] preserved sandbox: ${sandboxBase}`);
  } else {
    await rm(sandboxBase, { recursive: true, force: true });
  }
}

process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));

const exitCode = await new Promise((resolve) => {
  child.on('exit', (code) => resolve(code ?? 0));
  child.on('error', (error) => {
    console.error('[mille watch bench] failed to launch playground:', error);
    resolve(1);
  });
});
await stop('SIGTERM');
process.exitCode = exitCode;
