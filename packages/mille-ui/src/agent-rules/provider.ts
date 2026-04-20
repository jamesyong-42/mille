// Phase 14.2 — `registerAgentRulesDecorations` factory.
//
// Pattern mirrors `src/git/provider.ts` but much simpler: the matcher
// set is static per session (no external event source), so there is no
// batcher, no `getStatus` round-trip, and no ancestor propagation.
//
// The engine's `fx.registerDecorationProvider` takes a single argument
// whose `id` field carries the provider's identity (see
// `@vibecook/mille` `api.d.ts`). This matches Phase 13's finding.
//
// Opt-in by default: consumers only pay for the companion when they
// call `registerAgentRulesDecorations`. Nothing is auto-wired from the
// main `@vibecook/mille-ui` entry.

import type {
  Decoration,
  Entry,
  EntryId,
  FileExplorer,
} from '@vibecook/mille';
import type { PortFileExplorer } from '@vibecook/mille/port';

import type { AgentRuleMatcher } from './matchers.js';
import { DEFAULT_MATCHERS } from './matchers.js';

// ─── Minimal fx surface ───────────────────────────────────────────────

/**
 * Engine-level `DecorationProvider` shape. Re-declared locally so the
 * companion doesn't force a direction on the dependency graph; mirrors
 * `@vibecook/mille`'s `DecorationProvider` interface.
 */
export interface EngineDecorationProvider {
  readonly id: string;
  onDidChange(
    listener: (ids: readonly EntryId[]) => void,
  ): { dispose(): void };
  provide(entry: Entry): Decoration | null;
}

/**
 * Subset of `FileExplorer` the companion actually touches. Narrow on
 * purpose so scripted test fakes stay small.
 */
export interface FileExplorerLike {
  /**
   * Real-engine shape: `registerDecorationProvider(provider)`. Returns
   * a disposable. The provider object carries its own `id`.
   */
  registerDecorationProvider(
    provider: EngineDecorationProvider,
  ): { dispose(): void };
}

// ─── Options & handle ─────────────────────────────────────────────────

export interface RegisterAgentRulesOptions {
  /**
   * Phase A1 — accepts either the in-process `FileExplorer` or the
   * port-backed `PortFileExplorer`. Both surface
   * `registerDecorationProvider` so the wiring is identical; the
   * `FileExplorerLike` escape hatch stays for scripted test fakes.
   */
  readonly fx: FileExplorer | PortFileExplorer | FileExplorerLike;
  /**
   * Absolute workspace root. Currently informational — matchers key
   * off the entry's URI path directly. Kept in the options shape so
   * future matchers can be root-aware without an API break (e.g. a
   * matcher that only fires for `rootPath` + `/.cursor/rules/...`).
   */
  readonly rootPath: string;
  /** Provider id supplied to the engine. Default: `'agent-rules'`. */
  readonly providerId?: string;
  /**
   * Replaces the default matcher list wholesale. Use this when you
   * want to opt out of a specific default; pair with
   * `additionalMatchers` when you want to *add* to the defaults.
   */
  readonly matchers?: readonly AgentRuleMatcher[];
  /**
   * Appended to whichever base list is active (`matchers` if supplied,
   * otherwise `DEFAULT_MATCHERS`). Typical host usage: one or two
   * project-specific matchers layered on top of the built-ins.
   */
  readonly additionalMatchers?: readonly AgentRuleMatcher[];
  /**
   * Badge rendered on matched rows. Default: a robot emoji. Prefer an
   * SVG glyph in production themes for visual consistency with the
   * rest of the icon set; kept as a string so the companion itself
   * stays render-agnostic.
   */
  readonly badge?: string;
  /**
   * Optional override for the tooltip produced from a matched rule.
   * Defaults to `matcher.label`.
   */
  tooltipFor?(matcher: AgentRuleMatcher, entry: Entry): string | undefined;
}

export interface AgentRulesHandle {
  /** Unregister the decoration provider. Idempotent. */
  dispose(): void;
}

// ─── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_BADGE = '\u{1F916}'; // robot-face emoji; see RegisterAgentRulesOptions.badge
const DEFAULT_PROVIDER_ID = 'agent-rules';

// ─── Implementation ───────────────────────────────────────────────────

/**
 * Register an engine `DecorationProvider` that tags files belonging to
 * the "files-as-config" agentic patterns (Cursor/Kiro/Cline/Continue/
 * Claude/AGENTS.md/Codex/.rules). Opt-in — nothing auto-wires.
 *
 * Returns a handle with a single `dispose()` method that unregisters
 * the provider from the engine. Safe to call more than once.
 */
export function registerAgentRulesDecorations(
  options: RegisterAgentRulesOptions,
): AgentRulesHandle {
  const {
    fx,
    providerId = DEFAULT_PROVIDER_ID,
    matchers,
    additionalMatchers,
    badge = DEFAULT_BADGE,
    tooltipFor,
  } = options;

  // Resolve the effective matcher list.
  //   - If `matchers` is supplied, it REPLACES the defaults.
  //   - `additionalMatchers` is always concatenated onto the base.
  const base: readonly AgentRuleMatcher[] = matchers ?? DEFAULT_MATCHERS;
  const effective: readonly AgentRuleMatcher[] =
    additionalMatchers !== undefined && additionalMatchers.length > 0
      ? [...base, ...additionalMatchers]
      : base;

  let disposed = false;

  function resolvePath(entry: Entry): string | null {
    // Entries produced by the engine carry their URI indirectly
    // through the walker; the provider receives the `Entry` record
    // whose `name` is the leaf. The engine's `Entry` does not expose
    // the full absolute path on the record itself — callers that
    // need it typically derive it from the snapshot.
    //
    // For the matcher surface we rely on the `pathSegments` field (set
    // when compact-folders collapsed `a/b/c` into one row) OR the
    // entry's name. When neither carries the full path, we fall back
    // to matching against the plain `name`, which still handles
    // file-name-based rules (CLAUDE.md, AGENTS.md, CODEX.md,
    // .clinerules, .cursorrules, .rules). Directory-based rules
    // (.cursor/rules/*, .kiro/steering/*, .continue/*) require the
    // ancestor path; hosts that need those can pass the absolute path
    // into the matcher by using a custom `EntryLike` — see the
    // `_pathForEntry` symbol below.
    //
    // Concretely: prefer the engine-side path when the entry exposes
    // one (duck-typed off `path` / `_path`), otherwise synthesize a
    // slash-prefixed leaf from `name` so `endsWith('/NAME')` matchers
    // keep working.
    const maybePath = readEntryPath(entry);
    if (typeof maybePath === 'string' && maybePath.length > 0) {
      return maybePath;
    }
    if (typeof entry.name === 'string' && entry.name.length > 0) {
      return `/${entry.name}`;
    }
    return null;
  }

  function findMatcher(path: string): AgentRuleMatcher | null {
    for (const m of effective) {
      if (m.test(path)) return m;
    }
    return null;
  }

  function buildDecoration(
    matcher: AgentRuleMatcher,
    entry: Entry,
  ): Decoration {
    const tooltip = tooltipFor?.(matcher, entry) ?? matcher.label;
    return { badge, tooltip, propagate: false };
  }

  const provider: EngineDecorationProvider = {
    id: providerId,
    onDidChange(_listener: (ids: readonly EntryId[]) => void): {
      dispose(): void;
    } {
      // Static pattern set — no change events. Return a no-op
      // disposable so the engine's subscribe/dispose plumbing still
      // works.
      return {
        dispose(): void {
          /* no-op */
        },
      };
    },
    provide(entry: Entry): Decoration | null {
      if (disposed) return null;
      const path = resolvePath(entry);
      if (path === null) return null;
      const matcher = findMatcher(path);
      if (matcher === null) return null;
      return buildDecoration(matcher, entry);
    },
  };

  const registration = fx.registerDecorationProvider(provider);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch {
        /* swallow — idempotency trumps engine errors */
      }
    },
  };
}

// ─── Entry-path duck-typing ──────────────────────────────────────────

/**
 * The engine's official `Entry` shape doesn't carry an absolute path
 * (the tree is flat-array indexed by id; paths are reconstructed by
 * walking parents). Hosts and tests frequently pass entries that DO
 * carry a `path` or `_path` field — we opportunistically read that so
 * directory-based matchers work out of the box.
 *
 * This keeps the public API honest (we never *require* an extra
 * field) while making the common case one line of glue.
 */
function readEntryPath(entry: Entry): string | undefined {
  const anyEntry = entry as unknown as {
    readonly path?: unknown;
    readonly _path?: unknown;
    readonly uri?: { readonly path?: unknown };
  };
  if (typeof anyEntry.path === 'string') return anyEntry.path;
  if (typeof anyEntry._path === 'string') return anyEntry._path;
  if (
    anyEntry.uri !== undefined &&
    typeof anyEntry.uri.path === 'string'
  ) {
    return anyEntry.uri.path;
  }
  return undefined;
}

// Re-export so `registerAgentRulesDecorations({ matchers: [...] })`
// consumers don't need a separate import when composing with the
// defaults.
export { DEFAULT_MATCHERS } from './matchers.js';
