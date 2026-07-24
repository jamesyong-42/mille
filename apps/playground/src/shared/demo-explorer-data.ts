// Shared playground seed data for diagnostics + test-status.
//
// Used by both the utility-process decoration host and the renderer
// Problems / Failed Tests views so they stay in lockstep. Real hosts
// replace these Map clients with LSP / test-runner backends — the
// view projectors only need DiagnosticsClient / TestStatusClient.

import type { Diagnostic } from '@vibecook/mille-ui/diagnostics';
import type { TestResult } from '@vibecook/mille-ui/test-status';

/** Initial diagnostics seed (Phase 5.1 demo; live via Map client onChange). */
export function demoDiagnosticsSeed(): Map<string, readonly Diagnostic[]> {
  return new Map([
    [
      'packages/mille-ui/package.json',
      [
        {
          path: 'packages/mille-ui/package.json',
          severity: 'warning',
          message: 'Demo: consider pinning peerDependency ranges',
          source: 'playground',
        },
      ],
    ],
    [
      'packages/mille-ui/src/index.ts',
      [
        {
          path: 'packages/mille-ui/src/index.ts',
          severity: 'error',
          message: "Demo: Cannot find name 'example'",
          source: 'ts',
          code: 2304,
        },
        {
          path: 'packages/mille-ui/src/index.ts',
          severity: 'warning',
          message: 'Demo: unused export surface',
          source: 'eslint',
        },
      ],
    ],
    [
      'planning/IDE_EXPLORER_PARITY_PLAN.md',
      [
        {
          path: 'planning/IDE_EXPLORER_PARITY_PLAN.md',
          severity: 'info',
          message: 'Demo: Phase 5.2 views still open',
          source: 'playground',
        },
      ],
    ],
  ]);
}

/** Initial test-status seed (Phase 5.1 demo; live via Map client onChange). */
export function demoTestStatusSeed(): readonly TestResult[] {
  return [
    {
      path: 'packages/mille-ui/test/diagnostics-decorations.test.mjs',
      status: 'passed',
    },
    {
      path: 'packages/mille/test/undo-journal.test.mjs',
      status: 'failed',
      message: 'Demo: simulated assertion failure',
    },
    {
      path: 'packages/mille-ui/test/editor-state-decorations.test.mjs',
      status: 'running',
    },
  ];
}
