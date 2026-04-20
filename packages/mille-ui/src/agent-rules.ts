// Phase 14 — agent-rules decoration companion subpath entry.
//
// Exposed to consumers as `@vibecook/mille-ui/agent-rules`. Deliberately
// NOT re-exported from the main `@vibecook/mille-ui` entry so bundlers
// can tree-shake the companion when unused.
//
// Highlights files in the "files-as-config" agentic pattern
// (.cursor/rules, .kiro/steering/, .clinerules, .continue/, CLAUDE.md,
// AGENTS.md, CODEX.md, .rules). See MILLE_UI_SPEC.md §14.1.

export * from './agent-rules/index.js';
