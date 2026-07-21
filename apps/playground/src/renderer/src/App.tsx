// Playground — JetBrains-style Project tool window.
// Structural: pure tree surface first; settings tucked behind a gear.
// Engine transport (UtilityProcess + MessagePort) is unchanged.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { FileTreeProvider, FileTree, useFileTreeRef } from '@vibecook/mille-ui';
import type { IconTheme } from '@vibecook/mille-ui/icons';
import { defaultIconTheme, duotoneIconTheme, minimalIconTheme } from '@vibecook/mille-ui/icons';
import { createCommandRegistry, defaultCommands } from '@vibecook/mille-ui/commands';
import type { Entry, FileExplorer, VisibleRow } from '@vibecook/mille';
import { connectFileExplorer, type PortFileExplorer } from '@vibecook/mille/port';
import { fxPortReady, onFxPort } from './fx-port';
import { Toolbar, type ThemeMode } from './Toolbar';
import { stageIconTheme } from './stageIconTheme';
import { WatchBenchPanel } from './WatchBenchPanel';

interface ConnectionState {
  fx: PortFileExplorer;
  workspaceRoot: string;
}

interface EditorTab {
  readonly id: string;
  readonly title: string;
  readonly kind: 'file' | 'welcome';
  readonly entryId?: number;
  readonly body: string;
  readonly highlighted: boolean;
}

const WELCOME = `// Project tool window
//
// Double-click a file to open it here.
// ⌘F / Ctrl+F — filter tree
// F2 — rename · Delete — delete
// Right-click — context menu
`;

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function highlightSource(src: string): string {
  const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/(\/\/[^\n]*)/g, '<span class="cm">$1</span>')
    .replace(/('(?:\\.|[^'])*'|`(?:\\.|[^`])*`)/g, '<span class="str">$1</span>')
    .replace(
      /\b(import|from|const|await|export|function|return|new|async|type|interface)\b/g,
      '<span class="kw">$1</span>',
    )
    .replace(/\b(true|false|null|undefined)\b/g, '<span class="ty">$1</span>')
    .replace(/\b(\d+)\b/g, '<span class="num">$1</span>')
    .replace(/\b([A-Z][A-Za-z0-9_]*)\b/g, '<span class="ty">$1</span>')
    .replace(/\b([a-zA-Z_$][\w$]*)\s*(?=\()/g, '<span class="fn">$1</span>');
}

export function App(): ReactElement {
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let currentFx: PortFileExplorer | null = null;

    async function attach(port: MessagePort, workspaceRoot: string): Promise<void> {
      try {
        const fx = await connectFileExplorer(port, {
          mirrorCap: 20_000,
          prefetchRows: 200,
        });
        if (disposed) {
          void fx.dispose();
          return;
        }
        const prev = currentFx;
        currentFx = fx;
        setConn({ fx, workspaceRoot });
        if (prev !== null) void prev.dispose();
      } catch (err) {
        console.error('[renderer] attach failed', err);
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void fxPortReady.then(({ port, workspaceRoot }) => attach(port, workspaceRoot));
    const offSwap = onFxPort(({ port, workspaceRoot }) => {
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

  if (error) {
    return (
      <div className="boot">
        <div className="boot-card error">
          <div className="boot-mark" aria-hidden="true" />
          <h1>Connection failed</h1>
          <p>The UtilityProcess host could not complete the handshake.</p>
          <pre>{error}</pre>
        </div>
      </div>
    );
  }

  if (!conn) {
    return (
      <div className="boot">
        <div className="boot-card">
          <div className="boot-mark" aria-hidden="true" />
          <h1>Opening project…</h1>
          <p>Connecting to the mille host and walking roots.</p>
        </div>
      </div>
    );
  }

  return <Explorer fx={conn.fx} root={conn.workspaceRoot} />;
}

function Explorer({ fx, root }: { fx: PortFileExplorer; root: string }): ReactElement {
  const commands = useMemo(() => createCommandRegistry(defaultCommands), []);
  const treeRef = useFileTreeRef();
  const settingsRef = useRef<HTMLDivElement | null>(null);

  const [theme, setTheme] = useState<ThemeMode>('dark');
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  // Soft-duotone is the product default (see docs/icons-preview.html).
  const [iconThemeId, setIconThemeId] = useState<
    'duotone' | 'default' | 'stage' | 'material' | 'minimal'
  >('duotone');
  const [iconTheme, setIconTheme] = useState<IconTheme>(duotoneIconTheme);
  const [iconThemeStatus, setIconThemeStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>(
    'idle',
  );

  useEffect(() => {
    if (iconThemeId === 'duotone') {
      setIconTheme(duotoneIconTheme);
      setIconThemeStatus('idle');
      return;
    }
    if (iconThemeId === 'stage') {
      setIconTheme(stageIconTheme);
      setIconThemeStatus('idle');
      return;
    }
    if (iconThemeId === 'minimal') {
      setIconTheme(minimalIconTheme);
      setIconThemeStatus('idle');
      return;
    }
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
        const loaded = await mod.loadMaterialIconTheme();
        if (!cancelled) {
          setIconTheme(loaded);
          setIconThemeStatus('loaded');
        }
      } catch (err) {
        console.warn('[playground] Material theme failed:', err);
        if (!cancelled) {
          setIconTheme(duotoneIconTheme);
          setIconThemeId('duotone');
          setIconThemeStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [iconThemeId]);

  const [filterOpen, setFilterOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Editor pane is secondary — off by default so Project feels primary. */
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (evt: MouseEvent): void => {
      if (settingsRef.current !== null && !settingsRef.current.contains(evt.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [settingsOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'f' || e.key === 'F')) {
        const t = e.target;
        if (t instanceof HTMLElement && (t.closest('.code-panel') || t.closest('.code-scroll'))) {
          return;
        }
        e.preventDefault();
        setFilterOpen(true);
        requestAnimationFrame(() => treeRef.current?.focusFilter());
      }
      if (e.key === 'Escape' && filterOpen) {
        const active = document.activeElement;
        if (
          active instanceof HTMLInputElement &&
          active.closest('[data-mille-filter], .mille-filter')
        ) {
          if (active.value === '') {
            setFilterOpen(false);
            treeRef.current?.clearFilter();
          }
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [filterOpen, treeRef]);

  const [tabs, setTabs] = useState<EditorTab[]>(() => [
    {
      id: 'welcome',
      title: 'Welcome',
      kind: 'welcome',
      body: WELCOME,
      highlighted: true,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState('welcome');
  const openTabIdsRef = useRef(new Set(['welcome']));

  useEffect(() => {
    openTabIdsRef.current = new Set(tabs.map((t) => t.id));
  }, [tabs]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!;

  const openEntry = useCallback(
    async (entry: Entry | VisibleRow) => {
      if (entry.kind === 1) return;
      setEditorOpen(true);

      const tabId = `file:${entry.id}`;
      setActiveTabId(tabId);
      if (openTabIdsRef.current.has(tabId)) return;
      openTabIdsRef.current.add(tabId);

      setTabs((prev) => [
        ...prev.filter((t) => t.kind !== 'welcome'),
        {
          id: tabId,
          title: entry.name,
          kind: 'file',
          entryId: entry.id,
          body: '// loading…',
          highlighted: false,
        },
      ]);

      try {
        const text = await fx.readText(entry.id);
        const body = typeof text === 'string' ? text : String(text ?? '');
        const capped = body.length > 120_000 ? `${body.slice(0, 120_000)}\n\n// … truncated` : body;
        const highlight = /\.(ts|tsx|js|jsx|mjs|cjs|json|rs|md|css|toml|yml|yaml)$/i.test(
          entry.name,
        );
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, body: capped, highlighted: highlight } : t)),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  body: `// failed to read\n// ${msg}`,
                  highlighted: true,
                }
              : t,
          ),
        );
      }
    },
    [fx],
  );

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        openTabIdsRef.current = new Set(['welcome']);
        setActiveTabId('welcome');
        setEditorOpen(false);
        return [
          {
            id: 'welcome',
            title: 'Welcome',
            kind: 'welcome',
            body: WELCOME,
            highlighted: true,
          },
        ];
      }
      openTabIdsRef.current = new Set(next.map((t) => t.id));
      setActiveTabId((current) => (current === id ? next[next.length - 1]!.id : current));
      return next;
    });
  }, []);

  const collapseProject = useCallback(() => {
    treeRef.current?.collapseAll();
  }, [treeRef]);

  const workspaceLabel = useMemo(() => basename(root), [root]);

  return (
    <FileTreeProvider fx={fx as unknown as FileExplorer} commands={commands}>
      <div className={`app${editorOpen ? ' app--split' : ' app--project'}`}>
        <WatchBenchPanel fx={fx} />
        {/* ── Project tool window ─────────────────────────────── */}
        <aside className="sidebar">
          <div className="tool-header">
            <span className="tool-header-title">
              Project
              <span className="tool-header-view" title="View mode">
                ▾
              </span>
            </span>
            <span className="tool-header-meta" title={root}>
              {workspaceLabel}
            </span>
            <button
              type="button"
              title="Filter (⌘F)"
              aria-pressed={filterOpen}
              onClick={() => {
                setFilterOpen((v) => {
                  const next = !v;
                  if (next) {
                    requestAnimationFrame(() => treeRef.current?.focusFilter());
                  } else {
                    treeRef.current?.clearFilter();
                  }
                  return next;
                });
              }}
            >
              ⌕
            </button>
            <button type="button" title="Collapse all" onClick={collapseProject}>
              ⊟
            </button>
            <button
              type="button"
              title={editorOpen ? 'Hide editor' : 'Show editor'}
              aria-pressed={editorOpen}
              onClick={() => setEditorOpen((v) => !v)}
            >
              ⎇
            </button>
            <div className="settings-wrap" ref={settingsRef}>
              <button
                type="button"
                title="Settings"
                aria-expanded={settingsOpen}
                aria-pressed={settingsOpen}
                onClick={() => setSettingsOpen((v) => !v)}
              >
                ⚙
              </button>
              {settingsOpen ? (
                <div className="settings-popover" role="dialog" aria-label="Settings">
                  <Toolbar
                    fx={fx}
                    rootPath={root}
                    theme={theme}
                    onThemeChange={setTheme}
                    iconThemeId={iconThemeId}
                    onIconThemeChange={setIconThemeId}
                    iconThemeStatus={iconThemeStatus}
                    onReset={() => treeRef.current?.reset()}
                    compact
                  />
                </div>
              ) : null}
            </div>
          </div>

          <div
            className="tree-container"
            data-mille-theme={iconThemeId === 'minimal' ? 'minimal' : undefined}
          >
            <FileTree
              ref={treeRef}
              ariaLabel="Project"
              iconTheme={iconTheme}
              rowHeight={iconThemeId === 'minimal' ? 26 : 17}
              overscan={36}
              stickyRoots
              showFilter={filterOpen}
              searchMode="filter"
              onOpen={(row) => {
                void openEntry(row);
              }}
            />
          </div>
        </aside>

        {/* ── Optional editor (secondary) ─────────────────────── */}
        {editorOpen ? (
          <section className="editor" aria-label="Editor">
            <div className="tab-bar" role="tablist">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={tab.id === activeTab.id}
                  className={`tab${tab.id === activeTab.id ? ' is-active' : ''}`}
                  onClick={() => setActiveTabId(tab.id)}
                >
                  {tab.title}
                  {tab.kind === 'file' ? (
                    <span
                      className="tab-close"
                      role="button"
                      tabIndex={0}
                      aria-label={`Close ${tab.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tab.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          closeTab(tab.id);
                        }
                      }}
                    >
                      ×
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="code-panel">
              {activeTab.body.startsWith('// failed') ? (
                <div className="code-error">{activeTab.body}</div>
              ) : (
                <pre
                  className="code-scroll"
                  dangerouslySetInnerHTML={{
                    __html: activeTab.highlighted
                      ? highlightSource(activeTab.body)
                      : activeTab.body
                          .replace(/&/g, '&amp;')
                          .replace(/</g, '&lt;')
                          .replace(/>/g, '&gt;'),
                  }}
                />
              )}
            </div>
          </section>
        ) : null}
      </div>
    </FileTreeProvider>
  );
}
