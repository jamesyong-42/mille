// `@vibecook/mille-ui/headless` entry point.
//
// Thin re-export of `./headless/index.ts` so the subpath-export target
// (`dist/headless.js`) resolves as a single file. All actual content
// — hooks, component prop types, the `FileTreeHeadless` namespace, and
// the `milleClassNames` catalog — lives in `./headless/`.
//
// See MILLE_UI_PLAN.md Phase 12 and MILLE_UI_SPEC.md §4.9 / §10.3.

export * from './headless/index.js';
