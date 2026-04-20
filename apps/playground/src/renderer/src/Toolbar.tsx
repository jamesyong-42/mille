// Phase 15.4 + 15.5 — playground toolbar.
//
// Responsibilities:
//   - Theme toggle (light / dark) — sets `data-theme` on <html>.
//   - Icon-theme dropdown (default / material stub). Material is not
//     shipped in v0.1; selecting it surfaces an error toast and
//     restores `'default'` so the tree keeps rendering.
//   - Git decorations checkbox — calls `registerGitDecorations` with a
//     stub GitClient that treats every file as "unmodified" (no entries
//     returned) so the wiring is exercised without shelling out to
//     libgit2.
//   - Agent-rules checkbox — calls `registerAgentRulesDecorations` with
//     the built-in matcher list.
//   - Reset button — stubbed: logs an intent and blurs the focused
//     element. Full reset (selection/filter/clipboard clearing) will
//     land when the playground wires up imperative handles to the tree;
//     today the tree owns that state internally.
//
// IMPORTANT (v0.1 stub limit): the playground's engine handle is a
// `PortFileExplorer` (from `@vibecook/mille/port`). The port client
// does NOT implement `registerDecorationProvider` — decorations live on
// the native engine which runs in the UtilityProcess. Toggling the
// checkboxes on the port client therefore registers against a **shim
// adapter** that no-ops: the UI wiring is demonstrable end-to-end,
// but decorations won't actually appear on rows until v0.2 adds a
// host-side decoration forwarder frame across the port.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  registerGitDecorations,
  type GitClient,
  type GitDecorationsHandle,
  type GitStatusEntry,
} from '@vibecook/mille-ui/git';
import {
  registerAgentRulesDecorations,
  type AgentRulesHandle,
} from '@vibecook/mille-ui/agent-rules';
import type { PortFileExplorer } from '@vibecook/mille/port';
import type { Decoration, Entry, EntryId } from '@vibecook/mille';

export type ThemeMode = 'light' | 'dark';
export type IconThemeId = 'default' | 'material';

export interface ToolbarProps {
  readonly fx: PortFileExplorer;
  readonly rootPath: string;
  readonly theme: ThemeMode;
  onThemeChange(next: ThemeMode): void;
  readonly iconThemeId: IconThemeId;
  onIconThemeChange(next: IconThemeId): void;
}

/**
 * Minimal `FileExplorerLike` shim that satisfies the provider companions
 * but no-ops the registration. Used when the real engine (port client)
 * doesn't surface `registerDecorationProvider`. Exposed as a shim so the
 * toolbar keeps demonstrating the companion APIs without crashing.
 */
function makeDecorationShim(
  fx: PortFileExplorer,
): {
  registerDecorationProvider(provider: {
    readonly id: string;
    onDidChange(listener: (ids: readonly EntryId[]) => void): { dispose(): void };
    provide(entry: Entry): Decoration | null;
  }): { dispose(): void };
  // The shim also needs `getSnapshot` + `getByUri` for the git provider.
  getSnapshot(): ReturnType<PortFileExplorer['getSnapshot']>;
  getByUri(uri: { scheme: string; path: string }): Promise<null>;
} {
  return {
    registerDecorationProvider() {
      return { dispose() { /* no-op */ } };
    },
    getSnapshot() {
      return fx.getSnapshot();
    },
    async getByUri() {
      return null;
    },
  };
}

/**
 * Stub git client for v0.1. Returns an empty status map (everything
 * "unmodified"). Mutates `onChange` listeners into a dead subscription —
 * the stub never fires changes. A real implementation would watch
 * `.git/HEAD` + index through preload's node:fs or via libgit2.
 */
function createStubGitClient(): GitClient {
  return {
    async getStatus(): Promise<ReadonlyMap<string, GitStatusEntry>> {
      return new Map();
    },
    onChange(): () => void {
      return () => { /* no-op */ };
    },
  };
}

export function Toolbar(props: ToolbarProps): ReactElement {
  const { fx, rootPath, theme, onThemeChange, iconThemeId, onIconThemeChange } =
    props;

  const [toast, setToast] = useState<string | null>(null);

  // Decoration disposers — held in refs so toggling doesn't re-register.
  const gitHandleRef = useRef<GitDecorationsHandle | null>(null);
  const agentHandleRef = useRef<AgentRulesHandle | null>(null);

  const [gitOn, setGitOn] = useState(false);
  const [agentOn, setAgentOn] = useState(false);

  // Ensure every disposer fires on unmount.
  useEffect(() => {
    return () => {
      gitHandleRef.current?.dispose();
      gitHandleRef.current = null;
      agentHandleRef.current?.dispose();
      agentHandleRef.current = null;
    };
  }, []);

  const handleIconThemeChange = useCallback(
    (next: IconThemeId) => {
      if (next === 'material') {
        setToast(
          'Material icon theme bundle is not shipped in v0.1 — falling back to default.',
        );
        onIconThemeChange('default');
        return;
      }
      setToast(null);
      onIconThemeChange(next);
    },
    [onIconThemeChange],
  );

  const handleGitToggle = useCallback(
    (next: boolean) => {
      setGitOn(next);
      if (!next) {
        gitHandleRef.current?.dispose();
        gitHandleRef.current = null;
        return;
      }
      // Port client: registration goes through the no-op shim. The call
      // still exercises the companion's wiring path (options parsing,
      // initial `recompute`) so hosts observe identical API ergonomics
      // between port-backed and native-backed engines.
      try {
        gitHandleRef.current = registerGitDecorations({
          fx: makeDecorationShim(fx),
          client: createStubGitClient(),
          rootPath,
        });
        setToast(
          'Git decorations: stub client (everything "unmodified"). No visible badges in v0.1.',
        );
      } catch (err) {
        setToast(
          `Git decorations failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        setGitOn(false);
      }
    },
    [fx, rootPath],
  );

  const handleAgentToggle = useCallback(
    (next: boolean) => {
      setAgentOn(next);
      if (!next) {
        agentHandleRef.current?.dispose();
        agentHandleRef.current = null;
        return;
      }
      try {
        agentHandleRef.current = registerAgentRulesDecorations({
          fx: makeDecorationShim(fx),
          rootPath,
        });
        setToast(
          'Agent-rules decorations: registered with default matchers. No visible badges until v0.2 forwards decorations across the port.',
        );
      } catch (err) {
        setToast(
          `Agent-rules decorations failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        setAgentOn(false);
      }
    },
    [fx, rootPath],
  );

  const handleReset = useCallback(() => {
    // v0.1 reset is best-effort: the tree owns its selection / filter /
    // clipboard state internally (uncontrolled). We blur whatever is
    // focused so the keyboard handler re-enters fresh, and log an
    // intent for the dev console — a proper reset needs an imperative
    // handle (deferred to v0.2).
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    // eslint-disable-next-line no-console
    console.info('[playground] reset intent — selection/filter/clipboard live in-tree');
    setToast('Reset: best-effort. Imperative tree API lands in v0.2.');
  }, []);

  return (
    <div className="toolbar">
      <div className="toolbar-group" role="group" aria-label="Theme">
        <span>Theme</span>
        <button
          type="button"
          aria-pressed={theme === 'light'}
          onClick={() => onThemeChange('light')}
        >
          Light
        </button>
        <button
          type="button"
          aria-pressed={theme === 'dark'}
          onClick={() => onThemeChange('dark')}
        >
          Dark
        </button>
      </div>

      <div className="toolbar-group">
        <label>
          Icons
          <select
            value={iconThemeId}
            onChange={(e) =>
              handleIconThemeChange(e.target.value as IconThemeId)
            }
          >
            <option value="default">Default</option>
            <option value="material">Material (stub)</option>
          </select>
        </label>
      </div>

      <div className="toolbar-group">
        <label>
          <input
            type="checkbox"
            checked={gitOn}
            onChange={(e) => handleGitToggle(e.target.checked)}
          />
          Git decorations
        </label>
        <label>
          <input
            type="checkbox"
            checked={agentOn}
            onChange={(e) => handleAgentToggle(e.target.checked)}
          />
          Agent rules
        </label>
      </div>

      <div className="toolbar-group">
        <button type="button" onClick={handleReset}>
          Reset
        </button>
      </div>

      {toast ? (
        <span className="toolbar-toast" role="status" aria-live="polite">
          {toast}
        </span>
      ) : null}
    </div>
  );
}
