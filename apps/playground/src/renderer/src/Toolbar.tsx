// Phase 15.4 + 15.5 + A1.8 + B4.4 — playground toolbar.
//
// Responsibilities:
//   - Theme toggle (light / dark) — sets `data-theme` on <html>.
//   - Icon-theme dropdown (default / material stub). Material is not
//     shipped in v0.1; selecting it surfaces an error toast and
//     restores `'default'` so the tree keeps rendering.
//   - Git decorations checkbox — Phase B4 swapped the v0.1 stub for
//     `createShellGitClient`. It shells out to the host's `git`
//     binary and parses `--porcelain=v2 -z`, so modified / added /
//     untracked files now surface real badges. If `git` isn't on
//     PATH the client silently returns an empty map; no crash.
//   - Agent-rules checkbox — calls `registerAgentRulesDecorations` with
//     the built-in matcher list.
//   - Reset button — stubbed: logs an intent and blurs the focused
//     element. Full reset (selection/filter/clipboard clearing) will
//     land when the playground wires up imperative handles to the tree;
//     today the tree owns that state internally.
//
// Phase A1 removed the "port-safe" no-op shim — `PortFileExplorer` now
// ships `registerDecorationProvider`, so the companions register
// directly against it.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  createShellGitClient,
  registerGitDecorations,
  type GitDecorationsHandle,
} from '@vibecook/mille-ui/git';
import {
  registerAgentRulesDecorations,
  type AgentRulesHandle,
} from '@vibecook/mille-ui/agent-rules';
import type { PortFileExplorer } from '@vibecook/mille/port';

export type ThemeMode = 'light' | 'dark';
export type IconThemeId = 'default' | 'material';

export interface ToolbarProps {
  readonly fx: PortFileExplorer;
  readonly rootPath: string;
  readonly theme: ThemeMode;
  onThemeChange(next: ThemeMode): void;
  readonly iconThemeId: IconThemeId;
  onIconThemeChange(next: IconThemeId): void;
  /** v0.2 B5 — async-load lifecycle signal from the parent. Used to
   *  clear the "Loading Material…" toast when the bundle lands. */
  readonly iconThemeStatus?: 'idle' | 'loading' | 'loaded' | 'error';
}

export function Toolbar(props: ToolbarProps): ReactElement {
  const { fx, rootPath, theme, onThemeChange, iconThemeId, onIconThemeChange, iconThemeStatus } =
    props;

  const [toast, setToast] = useState<string | null>(null);

  // v0.2 B5 — clear the "Loading Material…" toast once the bundle
  // lands. Error paths already reset via the default fallback; this
  // covers the happy-path success case the parent signals via
  // `iconThemeStatus === 'loaded'`.
  useEffect(() => {
    if (iconThemeStatus === 'loaded') setToast(null);
  }, [iconThemeStatus]);

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
      // v0.2 B5 — Material bundle is real now. App.tsx async-loads it;
      // if the dynamic import rejects it falls back to default + logs.
      setToast(
        next === 'material' ? 'Loading Material Icon Theme…' : null,
      );
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
      // Phase B4 — real shell-based `GitClient`. Shells out to the
      // host's `git` binary and watches `.git/HEAD` + `.git/index` for
      // refresh. On a non-repo directory (or missing git binary) the
      // client returns an empty map and no badges render — no crash.
      try {
        const client = createShellGitClient({ rootPath });
        gitHandleRef.current = registerGitDecorations({
          fx,
          client,
          rootPath,
        });
        setToast(
          'Git decorations: live. Modified / staged / untracked files now carry real badges.',
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
          fx,
          rootPath,
        });
        setToast(
          'Agent-rules decorations: registered with default matchers. Badges now visible on matching rows.',
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

  const [pickerBusy, setPickerBusy] = useState(false);

  const handleOpenFolder = useCallback(async () => {
    if (pickerBusy) return;
    setPickerBusy(true);
    try {
      const picked = await window.millePlayground.pickAndOpenWorkspace();
      if (picked === null) {
        setToast('Open folder: cancelled.');
      } else {
        setToast(`Open folder: ${picked} — walking…`);
        // The new port arrives asynchronously via `fx-port`; App.tsx
        // swaps the connection. Decoration toggles reset on the new
        // Explorer remount because Toolbar's refs live under the old
        // unmounting instance — no manual cleanup needed here.
      }
    } catch (err) {
      setToast(
        `Open folder failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setPickerBusy(false);
    }
  }, [pickerBusy]);

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
      <div className="toolbar-group">
        <button type="button" onClick={handleOpenFolder} disabled={pickerBusy}>
          {pickerBusy ? 'Opening…' : 'Open folder…'}
        </button>
      </div>

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
            <option value="material">Material</option>
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
