// Phase 16.2 — bundle size budgets for @vibecook/mille-ui.
//
// Limits are pragmatic v0.1 snapshots of the current minified+brotlied
// bundle (measured on 2026-04-20). They pass today so CI can enforce
// "don't grow"; they are looser than the aspirational MILLE_UI_SPEC §12
// targets (45 KB main / 12 KB headless) because the headless entry
// currently re-exports more than it needs.
//
// TODO (v0.2): tighten headless to the SPEC §12 target of 12 KB by
// pruning its re-export surface (headless currently pulls in most of
// the styled tree's hook deps transitively). Candidate: split headless
// into a slim core (`/headless`) + a helpers bundle (`/headless/utils`).
//
// Running the check:
//   pnpm --filter @vibecook/mille-ui size

module.exports = [
  {
    name: '@vibecook/mille-ui',
    path: 'dist/index.js',
    limit: '30 KB',
    import: '*',
  },
  {
    name: '@vibecook/mille-ui/headless',
    path: 'dist/headless.js',
    limit: '25 KB',
    import: '*',
  },
];
