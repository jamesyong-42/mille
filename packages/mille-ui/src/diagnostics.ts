// Phase 5.1 — diagnostics decoration companion subpath entry.
//
// Exposed to consumers as `@vibecook/mille-ui/diagnostics`. Deliberately
// NOT re-exported from the main `@vibecook/mille-ui` entry so bundlers
// can tree-shake the companion when unused.
//
// Host supplies the `DiagnosticsClient` (LSP, ESLint, tsserver, …);
// this package stays dep-free of language-server stacks.

export * from './diagnostics/index.js';
