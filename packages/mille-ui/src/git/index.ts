// Phase 13 — `@vibecook/mille-ui/git` barrel.
//
// Public surface of the git decoration companion. See MILLE_UI_PLAN.md
// Phase 13 and MILLE_UI_SPEC.md §7 / §14.1.

export type {
  GitClient,
  GitStatusEntry,
  GitStatusLetter,
} from './client.js';

export type {
  BatchOptions,
  Batcher,
} from './batch.js';
export { createBatcher } from './batch.js';

export type {
  EngineDecorationProvider,
  FileExplorerLike,
  GitDecorationsHandle,
  RegisterGitDecorationsOptions,
} from './provider.js';
export { registerGitDecorations } from './provider.js';

// Phase B4 — real shell-based `GitClient`.
export type {
  ChildProcessLike,
  ShellGitClientOptions,
  SpawnLike,
} from './shell-client.js';
export { createShellGitClient } from './shell-client.js';

export type { WatchDotGitOptions } from './watch-dotgit.js';
export { watchDotGit } from './watch-dotgit.js';
