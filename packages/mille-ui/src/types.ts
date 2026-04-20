// Shared, phase-scoped types for @vibecook/mille-ui.
//
// These types are deliberately minimal during Phase 1. The broader type
// surface (FileTreeProps, FileTreeRowProps, MergedDecoration, IconTheme,
// ...) will land alongside the phases that introduce their consumers —
// see MILLE_UI_SPEC.md §3 for the full intended surface.

/**
 * Opaque handle for a command registry. Phase 2 is landing the real
 * `CommandRegistry` in parallel (owned by `src/commands.ts`). To keep
 * this phase decoupled, Provider consumers only see `dispatch`. The
 * Phase 2 registry will be structurally compatible with this handle
 * because it exposes the same `dispatch` signature; a later phase
 * formally re-types the Provider prop once both phases have merged.
 *
 * DO NOT import from `./commands.js` here — that would couple the two
 * in-flight phases and break Phase 2's development loop.
 */
export interface CommandRegistryHandle {
  dispatch(id: string, args?: unknown): void | Promise<void>;
}
