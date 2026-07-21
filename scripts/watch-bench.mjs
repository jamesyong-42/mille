#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repoRoot, 'packages', 'mille');
const executable = (name) =>
  join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);

let activeChild = null;

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    activeChild = child;
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code ?? 'unknown status'}`));
    });
  });
}

function forwardSignal(signal) {
  activeChild?.kill(signal);
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

try {
  console.log('[mille watch bench] building current native binding…');
  await run(
    executable('napi'),
    [
      'build',
      '--platform',
      '--manifest-path',
      '../../crates/mille-binding/Cargo.toml',
      '--output-dir',
      '.',
      '--no-js',
    ],
    packageRoot,
  );
  console.log('[mille watch bench] building current TypeScript package…');
  await run(executable('tsc'), ['--build'], packageRoot);
  await run(
    process.execPath,
    [join(repoRoot, 'apps', 'playground', 'scripts', 'watch-bench.mjs'), ...process.argv.slice(2)],
    join(repoRoot, 'apps', 'playground'),
  );
} catch (error) {
  console.error('[mille watch bench]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
