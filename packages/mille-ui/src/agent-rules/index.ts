// Phase 14 — `@vibecook/mille-ui/agent-rules` barrel.
//
// Public surface of the agent-rules decoration companion. See
// MILLE_UI_SPEC.md §14.1 and MILLE_UI_PLAN.md Phase 14.

export type { AgentRuleMatcher } from './matchers.js';
export { DEFAULT_MATCHERS } from './matchers.js';

export type {
  AgentRulesHandle,
  EngineDecorationProvider,
  FileExplorerLike,
  RegisterAgentRulesOptions,
} from './provider.js';
export { registerAgentRulesDecorations } from './provider.js';
