#!/usr/bin/env node

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    `Usage: pnpm bench:watch -- [options]\n\nOptions:\n  --operations N   File operations to execute (default 240)\n  --debounce MS    Native watcher debounce (default 40)\n  --timeout MS     Per-operation convergence timeout (default 5000)\n  --pause MS       Extra pause after each observed paint (default 0)\n  --keep           Preserve the temporary sandbox after exit\n  --exit           Close the playground after completion\n`,
  );
  process.exit(0);
}

const operations = Math.max(1, Math.floor(readNumber(args, '--operations', 240)));
const debounceMs = Math.floor(readNumber(args, '--debounce', 40));
const timeoutMs = Math.max(100, Math.floor(readNumber(args, '--timeout', 5_000)));
const pauseMs = Math.floor(readNumber(args, '--pause', 0));
const keep = args.includes('--keep');
const exitOnComplete = args.includes('--exit');

const sandboxBase = await mkdtemp(join(tmpdir(), 'mille-playground-watch-bench-'));
const workspaceRoot = join(sandboxBase, 'workspace');
const reportPath = join(sandboxBase, 'watch-bench-report.json');
await mkdir(workspaceRoot);

const binary = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite',
);
console.log(`[mille watch bench] sandbox: ${workspaceRoot}`);
console.log(`[mille watch bench] report:  ${reportPath}`);
console.log(
  `[mille watch bench] operations=${operations} debounce=${debounceMs}ms timeout=${timeoutMs}ms`,
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
    MILLE_WATCH_BENCH_DEBOUNCE_MS: String(debounceMs),
    MILLE_WATCH_BENCH_TIMEOUT_MS: String(timeoutMs),
    MILLE_WATCH_BENCH_PAUSE_MS: String(pauseMs),
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
