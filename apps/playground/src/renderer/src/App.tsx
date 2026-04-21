// Phase 15.3 — mille-ui playground renderer.
//
// Replaces the hand-rolled tree from the engine-only reference with the
// full `<FileTreeProvider>` + `<FileTree>` composition from
// `@vibecook/mille-ui`. Engine transport (UtilityProcess + port) is
// unchanged from the reference snapshot at `src.engine-only.reference/`.
//
// The toolbar handles light/dark theme toggle, icon-theme swap (default
// vs material stub), and decoration-provider on/off for git + agent
// rules. See `./Toolbar.tsx`.

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { FileTreeProvider, FileTree, useFileTreeRef } from '@vibecook/mille-ui';
import type { IconTheme } from '@vibecook/mille-ui/icons';
import { defaultIconTheme } from '@vibecook/mille-ui/icons';
import { createCommandRegistry, defaultCommands } from '@vibecook/mille-ui/commands';
import type { FileExplorer } from '@vibecook/mille';
import { connectFileExplorer, type PortFileExplorer } from '@vibecook/mille/port';
import { fxPortReady, onFxPort } from './fx-port';
import { Toolbar, type ThemeMode } from './Toolbar';

interface ConnectionState {
  fx: PortFileExplorer;
  workspaceRoot: string;
}

export function App(): ReactElement {
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let currentFx: PortFileExplorer | null = null;

    async function attach(port: MessagePort, workspaceRoot: string): Promise<void> {
      console.log(`[renderer] attach(${workspaceRoot}) — calling connectFileExplorer`);
      try {
        const fx = await connectFileExplorer(port, {
          mirrorCap: 20_000,
          prefetchRows: 200,
        });
        console.log(`[renderer] connected — treeVersion=${fx.getTreeVersion()}`);
        if (disposed) {
          void fx.dispose();
          return;
        }
        const prev = currentFx;
        currentFx = fx;
        setConn({ fx, workspaceRoot });
        if (prev !== null) void prev.dispose();
        // Heartbeat: log every snapshot change so we can see if the
        // walker's discoveries are flowing as deltas post-handshake.
        let lastVersion = fx.getTreeVersion();
        const sub = fx.on('change', () => {
          const v = fx.getTreeVersion();
          if (v !== lastVersion) {
            const snap = fx.getSnapshot();
            console.log(
              `[renderer] tree change: v${lastVersion} → v${v}, roots=${snap.roots().length}`,
            );
            lastVersion = v;
          }
        });
        // Clean up on next swap.
        const oldDispose = currentFx.dispose.bind(currentFx);
        currentFx.dispose = async () => {
          sub.dispose();
          await oldDispose();
        };
      } catch (err) {
        console.error('[renderer] attach failed', err);
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void fxPortReady.then(({ port, workspaceRoot }) => {
      console.log(`[renderer] initial fx-port for ${workspaceRoot}`);
      return attach(port, workspaceRoot);
    });

    const offSwap = onFxPort(({ port, workspaceRoot }) => {
      console.log(`[renderer] swap fx-port for ${workspaceRoot}`);
      setError(null);
      setConn(null);
      void attach(port, workspaceRoot);
    });

    return () => {
      disposed = true;
      offSwap();
      void currentFx?.dispose();
    };
  }, []);

  if (error) return <pre className="error">connection failed: {error}</pre>;
  if (!conn) {
    return (
      <div className="loading">
        connecting to mille host…
        <div className="loading-sub">
          walking the workspace — large trees (e.g. monorepos with many
          node_modules) can take up to a minute on first connect.
        </div>
      </div>
    );
  }

  return <Explorer fx={conn.fx} root={conn.workspaceRoot} />;
}

function Explorer({ fx, root }: { fx: PortFileExplorer; root: string }): ReactElement {
  // Command registry — fresh per fx so the shadow/restore stack starts
  // empty on reconnect. `defaultCommands` gives us tree structure +
  // mutation commands (rename / delete / move / copy / paste / open).
  const commands = useMemo(() => createCommandRegistry(defaultCommands), []);

  // v0.2 B6 — imperative handle for the tree. Lets the Toolbar's Reset
  // button actually clear selection / filter / clipboard end-to-end.
  const treeRef = useFileTreeRef();

  // Theme: toggles `data-theme` on <html>. The tokens.css we import at
  // entry defines both light and dark palettes gated on that attribute.
  const [theme, setTheme] = useState<ThemeMode>('dark');
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  // Icon theme selection. `'material'` is a stub in v0.1 — swapping to
  // it surfaces an error in the toolbar and falls back to default so
  // the tree stays rendered.
  const [iconThemeId, setIconThemeId] = useState<'default' | 'material'>('default');
  const [iconTheme, setIconTheme] = useState<IconTheme>(defaultIconTheme);
  // 'idle' | 'loading' | 'loaded' | 'error'. Toolbar uses this to
  // clear the "Loading Material…" toast when the async import lands.
  const [iconThemeStatus, setIconThemeStatus] = useState<
    'idle' | 'loading' | 'loaded' | 'error'
  >('idle');

  // v0.2 B5 — async-load Material Icon Theme bundle on demand. Falls
  // back to default if the bundle fails (e.g., offline CI stub).
  useEffect(() => {
    if (iconThemeId === 'default') {
      setIconTheme(defaultIconTheme);
      setIconThemeStatus('idle');
      return;
    }
    let cancelled = false;
    setIconThemeStatus('loading');
    void (async () => {
      try {
        const mod = await import('@vibecook/mille-ui/icons/material');
        const theme = await mod.loadMaterialIconTheme();
        if (!cancelled) {
          setIconTheme(theme);
          setIconThemeStatus('loaded');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[playground] Material theme failed to load:', err);
        if (!cancelled) {
          setIconTheme(defaultIconTheme);
          setIconThemeId('default');
          setIconThemeStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [iconThemeId]);

  // Port clients don't implement `registerDecorationProvider`; the
  // decoration pipeline lives on the native `FileExplorer` only. Keep
  // the toolbar toggles functional but no-op at the port boundary so
  // the UX stays coherent; a real libgit2/isomorphic-git wiring lands
  // in v0.2 alongside a host-side decoration forwarder.

  return (
    <FileTreeProvider fx={fx as unknown as FileExplorer} commands={commands}>
      <div className="app">
        <header>
          <h1>mille · playground</h1>
          <div className="meta">
            <span>root: {root}</span>
            <span>· version: {fx.getTreeVersion()}</span>
          </div>
        </header>
        <Toolbar
          fx={fx}
          rootPath={root}
          theme={theme}
          onThemeChange={setTheme}
          iconThemeId={iconThemeId}
          onIconThemeChange={setIconThemeId}
          iconThemeStatus={iconThemeStatus}
          onReset={() => treeRef.current?.reset()}
        />
        <div className="tree-container">
          <FileTree
            ref={treeRef}
            ariaLabel="Workspace files"
            iconTheme={iconTheme}
            showFilter
            searchMode="filter"
            onOpen={(row) => {
              // eslint-disable-next-line no-console
              console.log('[playground] open', row);
            }}
          />
        </div>
      </div>
    </FileTreeProvider>
  );
}
