// Public barrel for the commands sub-module.
//
// Everything here is pure TypeScript — no React, no engine calls. Consumers
// import from `@vibecook/mille-ui/commands` (or the top-level package once
// Phase 1+ re-exports land).

export { createCommandRegistry } from './registry.js';
export { evaluateWhen } from './when.js';
export {
  parseKeybinding,
  matchKeybinding,
  formatKeybinding,
  type ParsedKeybinding,
  type KeyboardEventLike,
} from './keybinding.js';
export {
  defaultCommands,
  treeDefaults,
  mutationDefaults,
} from './defaults.js';
export type {
  Command,
  CommandContext,
  CommandDisposable,
  CommandRegistry,
  CommandRegistryOptions,
  FileRefreshTarget,
  HostHooks,
} from './types.js';
export type {
  FileSearchRequest,
  FileSearchRequestKind,
} from '../file-search.js';
