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
//   - Reset button — v0.2 B6 wired up the mille-ui imperative `<FileTree>`
//     handle (`FileTreeRef.reset()`). The parent (App.tsx) passes
//     `onReset` which calls into the ref and clears selection / filter
//     / clipboard in one shot, then returns keyboard focus to the tree.
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
  registerAgentRulesDecorations,
  type AgentRulesHandle,
} from '@vibecook/mille-ui/agent-rules';
import type { PortFileExplorer } from '@vibecook/mille/port';

export type ThemeMode = 'light' | 'dark';
/** `stage` = playground mock icons (default). */
export type IconThemeId = 'stage' | 'default' | 'material';

/**
 * v0.2 B7 — compact path display for the recents dropdown. Absolute
 * paths inside `$HOME` get `~/…` rewriting; anything else gets
 * left-truncated (middle-ellipsis feels clever but reads worse at
 * a glance). Full path is preserved on hover via `title` at the
 * call site. Lives here (module-local) because its only consumer is
 * the recents menu below — not worth its own file.
 *
 * We intentionally don't call into `path.basename` / the electron
 * API surface from the renderer; this is string-level pretty-printing
 * with a homedir hint shipped from the main process would be nicer,
 * but the extra IPC round-trip isn't worth it for a menu entry.
 */
const HOME_PREFIX_HINT = /^\/Users\/[^/]+\//;
const MAX_DISPLAY_LEN = 40;

function formatRecentPath(raw: string): string {
  let display = raw;
  // Best-effort home substitution. A renderer has no `os.homedir()`,
  // so we pattern-match macOS-style absolute home paths. Linux /root
  // and /home/xxx fall through to the ellipse branch below, which
  // handles them safely even if the tilde doesn't appear.
  const homeMatch = HOME_PREFIX_HINT.exec(raw);
  if (homeMatch !== null) {
    display = '~/' + raw.slice(homeMatch[0].length);
  } else if (raw.startsWith('/home/')) {
    const rest = raw.slice('/home/'.length);
    const slash = rest.indexOf('/');
    if (slash > 0) display = '~/' + rest.slice(slash + 1);
  }
  if (display.length > MAX_DISPLAY_LEN) {
    display = '…' + display.slice(display.length - (MAX_DISPLAY_LEN - 1));
  }
  return display;
}

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
  /**
   * v0.2 B6 — parent-supplied reset callback. Typically calls
   * `treeRef.current?.reset()` to clear selection, filter, and
   * clipboard, and return keyboard focus to the tree.
   */
  onReset?(): void;
  /** Vertical stack for the settings popover (Project gear). */
  readonly compact?: boolean;
}

export function Toolbar(props: ToolbarProps): ReactElement {
  const {
    fx,
    rootPath,
    theme,
    onThemeChange,
    iconThemeId,
    onIconThemeChange,
    iconThemeStatus,
    onReset,
    compact = false,
  } = props;

  const [toast, setToast] = useState<string | null>(null);

  // v0.2 B5 — clear the "Loading Material…" toast once the bundle
  // lands. Error paths already reset via the default fallback; this
  // covers the happy-path success case the parent signals via
  // `iconThemeStatus === 'loaded'`.
  useEffect(() => {
    if (iconThemeStatus === 'loaded') setToast(null);
  }, [iconThemeStatus]);

  // Agent-rules runs in the renderer — matchers are static, no Node.
  const agentHandleRef = useRef<AgentRulesHandle | null>(null);

  const [gitOn, setGitOn] = useState(true);
  const [agentOn, setAgentOn] = useState(false);

  // Auto-enable git decorations so the explorer matches the docs mock
  // (M / A badges) without requiring a manual toggle on first open.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await window.millePlayground.setGitDecorations(true);
        if (!cancelled) setGitOn(true);
      } catch {
        if (!cancelled) setGitOn(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fx]);

  // Ensure every disposer fires on unmount.
  useEffect(() => {
    return () => {
      agentHandleRef.current?.dispose();
      agentHandleRef.current = null;
      // Fire-and-forget git-off on unmount. The utility-side registration
      // would also clean up on process exit; this just tightens the loop.
      void window.millePlayground.setGitDecorations(false).catch(() => {});
    };
  }, []);

  const handleIconThemeChange = useCallback(
    (next: IconThemeId) => {
      // v0.2 B5 — Material bundle is real now. App.tsx async-loads it;
      // if the dynamic import rejects it falls back to default + logs.
      setToast(
        next === 'material'
          ? 'Loading Material Icon Theme…'
          : next === 'stage'
            ? 'Stage icons (docs mock).'
            : next === 'default'
              ? 'Default monoline icons.'
              : null,
      );
      onIconThemeChange(next);
    },
    [onIconThemeChange],
  );

  const handleGitToggle = useCallback(async (next: boolean) => {
    setGitOn(next);
    // v0.2 — the shell-based `GitClient` uses `node:child_process`, so
    // it cannot live in the renderer. The provider is registered in
    // the fx utility process; A1's decoration fan-out carries badges
    // to the client mirror automatically. We just flip the toggle via
    // IPC.
    try {
      await window.millePlayground.setGitDecorations(next);
      setToast(
        next
          ? 'Git decorations: live. Modified / staged / untracked files now carry real badges.'
          : 'Git decorations disabled.',
      );
    } catch (err) {
      setToast(
        `Git decorations failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      setGitOn(!next);
    }
  }, []);

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

  // v0.2 B7 — recents dropdown state.
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const recentsWrapRef = useRef<HTMLDivElement | null>(null);

  // Close the menu when clicking outside. Attached only while open so
  // we don't leak a listener on every toolbar. Uses `mousedown` so the
  // close fires before React commits any inner click — matches the
  // usual dropdown convention.
  useEffect(() => {
    if (!recentsOpen) return;
    const onDown = (evt: MouseEvent): void => {
      const root = recentsWrapRef.current;
      if (root !== null && !root.contains(evt.target as Node)) {
        setRecentsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [recentsOpen]);

  const toggleRecents = useCallback(async () => {
    const next = !recentsOpen;
    setRecentsOpen(next);
    if (next) {
      try {
        const list = await window.millePlayground.getRecentFolders();
        // Filter out the current root — clicking it would be a no-op
        // anyway and the parent handshake idempotency would still
        // re-attach. Hiding keeps the list focused on *other* options.
        setRecents(list.filter((p) => p !== rootPath));
      } catch {
        setRecents([]);
      }
    }
  }, [recentsOpen, rootPath]);

  const handlePickBrowse = useCallback(async () => {
    if (pickerBusy) return;
    setRecentsOpen(false);
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

  const handlePickRecent = useCallback(
    async (path: string) => {
      if (pickerBusy) return;
      setRecentsOpen(false);
      // Re-picking the already-open root is treated as a no-op. The
      // main-process handshake is idempotent (kills + re-forks the
      // utility), but surfacing a brief toast is friendlier than a
      // silent reload. Filter above usually prevents reaching here.
      if (path === rootPath) {
        setToast(`Already open: ${path}`);
        return;
      }
      setPickerBusy(true);
      try {
        await window.millePlayground.openWorkspace(path);
        setToast(`Open folder: ${path} — walking…`);
      } catch (err) {
        setToast(
          `Open folder failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setPickerBusy(false);
      }
    },
    [pickerBusy, rootPath],
  );

  const handleReset = useCallback(() => {
    // v0.2 B6 — delegate to the parent's imperative-handle wiring.
    // `onReset` calls `treeRef.current?.reset()` which clears
    // selection + filter + clipboard in one shot and returns keyboard
    // focus to the tree. When `onReset` is absent (older host), fall
    // back to the v0.1 best-effort blur.
    if (onReset) {
      onReset();
      setToast('Tree reset: selection / filter / clipboard cleared.');
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    setToast('Reset: best-effort. Host did not supply onReset.');
  }, [onReset]);

  return (
    <div className={compact ? 'toolbar toolbar--compact' : 'toolbar'}>
      <div className="toolbar-group">
        <div className="recents-wrap" ref={recentsWrapRef}>
          <button
            type="button"
            onClick={() => void toggleRecents()}
            disabled={pickerBusy}
            aria-haspopup="menu"
            aria-expanded={recentsOpen}
          >
            {pickerBusy ? 'Opening…' : 'Open folder… ▾'}
          </button>
          {recentsOpen ? (
            <ul className="recents-menu" role="menu">
              {recents.length === 0 ? (
                <li role="none">
                  <span
                    className="recents-empty"
                    role="menuitem"
                    aria-disabled="true"
                  >
                    No recent folders yet
                  </span>
                </li>
              ) : (
                recents.map((p) => (
                  <li key={p} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      title={p}
                      onClick={() => void handlePickRecent(p)}
                    >
                      {formatRecentPath(p)}
                    </button>
                  </li>
                ))
              )}
              <li role="separator" aria-hidden="true">
                <hr />
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handlePickBrowse()}
                >
                  Browse…
                </button>
              </li>
            </ul>
          ) : null}
        </div>
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
            <option value="material">Material</option>
            <option value="default">Default</option>
            <option value="stage">Stage</option>
          </select>
        </label>
      </div>

      <div className="toolbar-group">
        <label>
          <input
            type="checkbox"
            checked={gitOn}
            onChange={(e) => void handleGitToggle(e.target.checked)}
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
