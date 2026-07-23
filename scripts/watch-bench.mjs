#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repoRoot, 'packages', 'mille');
const uiPackageRoot = join(repoRoot, 'packages', 'mille-ui');
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
      else {
        const error = new Error(`${command} exited with ${signal ?? code ?? 'unknown status'}`);
        error.exitCode = typeof code === 'number' ? code : 1;
        reject(error);
      }
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
  console.log('[mille watch bench] building current React package…');
  await run(executable('tsc'), ['--build'], uiPackageRoot);
  const packageEntry = pathToFileURL(join(packageRoot, 'dist', 'index.js'));
  packageEntry.searchParams.set('bench-build', String(Date.now()));
  const { buildIdentity } = await import(packageEntry.href);
  const uiManifest = JSON.parse(await readFile(join(uiPackageRoot, 'package.json'), 'utf8'));
  const identity = {
    ...buildIdentity(),
    uiPackageVersion: typeof uiManifest.version === 'string' ? uiManifest.version : 'unknown',
  };
  process.env.MILLE_BUILD_IDENTITY_JSON = JSON.stringify(identity);
  console.log('[mille watch bench] build', JSON.stringify(identity));
  await run(
    process.execPath,
    [join(repoRoot, 'apps', 'playground', 'scripts', 'watch-bench.mjs'), ...process.argv.slice(2)],
    join(repoRoot, 'apps', 'playground'),
  );
} catch (error) {
  console.error('[mille watch bench]', error instanceof Error ? error.message : String(error));
  process.exitCode =
    error && typeof error === 'object' && Number.isInteger(error.exitCode) ? error.exitCode : 1;
}
