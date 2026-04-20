// Phase 14.1 — built-in matcher list for the agent-rules decoration
// companion.
//
// Each matcher tests an entry's path (POSIX-normalized, as the engine
// emits) and returns true when the entry is part of the "files-as-
// config" agentic pattern documented in
// `research-findings/01-mainstream-editors.md` and `MILLE_UI_SPEC.md`
// §14.1.
//
// Path-matching discipline:
//   - Directory patterns always look for a fully-bounded segment (a
//     leading `/.foo/` rather than a substring `foo`) so
//     `/repo/somefoo/bar` cannot collide with `/.foo/bar`.
//   - Exact-filename patterns use `endsWith('/NAME')` so
//     `something/CLAUDE.md.txt` or `docs/someclaudemd` cannot match.
//   - All matchers assume the path is absolute or at least
//     slash-prefixed relative to its workspace root. The provider
//     defensively normalizes the URI path before invoking matchers.

export interface AgentRuleMatcher {
  /** Stable identifier; surfaces in the `Decoration.tooltip` suffix. */
  readonly id: string;
  /** Short human label used for the default tooltip. */
  readonly label: string;
  /** Returns true when `path` represents a file of this agent-rule kind. */
  test(path: string): boolean;
}

/**
 * Built-in matchers for the agentic configuration patterns surveyed in
 * the research findings. Frozen so consumers can't mutate the shared
 * array; individual matchers are plain objects that consumers may
 * compose with via `additionalMatchers` on `registerAgentRulesDecorations`.
 */
export const DEFAULT_MATCHERS: readonly AgentRuleMatcher[] = Object.freeze([
  {
    id: 'cursor-rules',
    label: 'Cursor rules',
    test: (p: string): boolean =>
      p.includes('/.cursor/rules/') || p.endsWith('/.cursorrules'),
  },
  {
    id: 'kiro-steering',
    label: 'Kiro steering',
    test: (p: string): boolean => p.includes('/.kiro/steering/'),
  },
  {
    id: 'cline-rules',
    label: 'Cline rules',
    test: (p: string): boolean =>
      p.endsWith('/.clinerules') || p.endsWith('/.clinerules.md'),
  },
  {
    id: 'continue-config',
    label: 'Continue config',
    test: (p: string): boolean => p.includes('/.continue/'),
  },
  {
    id: 'claude-md',
    label: 'Claude memory',
    test: (p: string): boolean =>
      p.endsWith('/CLAUDE.md') || p.endsWith('/CLAUDE.local.md'),
  },
  {
    id: 'agents-md',
    label: 'AGENTS.md',
    test: (p: string): boolean => p.endsWith('/AGENTS.md'),
  },
  {
    id: 'rules-file',
    label: 'Agent rules',
    test: (p: string): boolean => p.endsWith('/.rules'),
  },
  {
    id: 'codex-md',
    label: 'OpenAI Codex guidance',
    test: (p: string): boolean => p.endsWith('/CODEX.md'),
  },
]);
