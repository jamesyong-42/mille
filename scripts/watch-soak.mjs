#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repoRoot, 'packages', 'mille');
const executable = (name) =>
  join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code ?? 'unknown status'}`));
    });
  });
}

try {
  console.log('[mille watch soak] building current native binding…');
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
  console.log('[mille watch soak] building current TypeScript package…');
  await run(executable('tsc'), ['--build'], packageRoot);
  await run(
    process.execPath,
    [join(packageRoot, 'bench', 'watch-soak.mjs'), ...process.argv.slice(2)],
    repoRoot,
  );
} catch (error) {
  console.error('[mille watch soak]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
