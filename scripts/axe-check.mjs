#!/usr/bin/env node
// Phase 6.3 — WCAG A/AA audit of the playground renderer with axe-core.
//
// The unit suite hand-rolls the ARIA tree pattern because happy-dom has no
// layout, so axe's contrast and visibility rules cannot mean anything there.
// This runs the real thing: Electron, real styles, real computed colours.
//
//   node scripts/axe-check.mjs [--report axe-report.json] [--root <dir>]
//
// Exits non-zero when axe reports any WCAG 2.0/2.1 A or AA violation. On
// headless Linux, wrap in `xvfb-run` exactly like the watch bench.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const playgroundDir = join(repoRoot, 'apps', 'playground');
const args = process.argv.slice(2);

function stringOption(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}

const reportArg = stringOption('--report', 'axe-report.json');
const reportPath = isAbsolute(reportArg) ? reportArg : resolve(process.cwd(), reportArg);

// A tiny throwaway workspace keeps the audit independent of whatever the
// developer happens to have open, and keeps the walk instant.
let workspaceRoot = stringOption('--root', null);
if (workspaceRoot === null) {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mille-axe-'));
  writeFileSync(join(workspaceRoot, 'README.md'), '# axe fixture\n');
  writeFileSync(join(workspaceRoot, 'index.ts'), 'export const ok = true;\n');
}

const binary = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite',
);

console.log(`[mille axe] workspace: ${workspaceRoot}`);
console.log(`[mille axe] report:    ${reportPath}`);

// `dev` rather than `preview`: it builds first, so this does not depend on a
// prior `electron-vite build` having left `out/` behind. Same choice the watch
// bench makes.
const child = spawn(binary, ['dev'], {
  cwd: playgroundDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    WORKSPACE_ROOT: workspaceRoot,
    MILLE_AXE_REPORT: reportPath,
    // Demo diagnostics seed paths that do not exist in the fixture; the audit
    // only cares about the rendered chrome and tree.
    MILLE_DEMO_DIAGNOSTICS: '0',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[mille axe] terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
child.on('error', (error) => {
  console.error('[mille axe] failed to launch:', error.message);
  process.exit(1);
});
