// Phase 13 — git decoration companion subpath entry.
//
// Exposed to consumers as `@vibecook/mille-ui/git`. Deliberately NOT
// re-exported from the main `@vibecook/mille-ui` entry so bundlers
// can tree-shake the git companion when unused.
//
// Host supplies the `GitClient` (libgit2 via napi, isomorphic-git,
// etc.); this package stays dep-free.

export * from './git/index.js';
