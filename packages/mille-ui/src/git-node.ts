// `@vibecook/mille-ui/git/node` — Node-only bits of the git companion.
//
// Lives here rather than `/git` so the renderer-facing barrel stays
// bundler-safe (no `node:child_process` / `node:fs` imports leaking
// into browser code). Host-side consumers (Electron main process,
// utility process, Node CLI) import from this subpath:
//
//   import { createShellGitClient } from '@vibecook/mille-ui/git/node';
//
// The renderer-safe `/git` barrel continues to export the
// `GitClient` type, `registerGitDecorations`, and the batcher — all
// of which are Node-free and safe to consume in a browser bundle.

export { createShellGitClient } from './git/shell-client.js';
export { resolveGitDir, watchDotGit } from './git/watch-dotgit.js';
export {
  assertPathUnderRoot,
  assertSafeRevision,
  createShellFileHistoryClient,
  createShellScmClient,
  parseGitLogLines,
} from './git/shell-history.js';
export type { ShellHistoryOptions } from './git/shell-history.js';
