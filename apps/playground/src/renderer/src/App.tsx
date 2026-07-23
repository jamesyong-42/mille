// Playground — JetBrains-style Project tool window.
// Structural: pure tree surface first; settings tucked behind a gear.
// Engine transport (UtilityProcess + MessagePort) is unchanged.

import {
  Profiler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ProfilerOnRenderCallback,
  type ReactElement,
} from 'react';
import {
  FileTreeProvider,
  FileTree,
  serializeFileTreeNavigationState,
  useFileTreeRef,
  type ActiveEntryPolicy,
  type FileActionTarget,
  type FileOpenEvent,
  type FileTreeNavigationState,
} from '@vibecook/mille-ui';
import type { IconTheme } from '@vibecook/mille-ui/icons';
import { defaultIconTheme, duotoneIconTheme, minimalIconTheme } from '@vibecook/mille-ui/icons';
import { createCommandRegistry, defaultCommands } from '@vibecook/mille-ui/commands';
import type { Entry, FileExplorer, VisibleRow } from '@vibecook/mille';
import { connectFileExplorer, type PortFileExplorer } from '@vibecook/mille/port';
import { fxPortReady, onFxPort } from './fx-port';
import { Toolbar, type ThemeMode } from './Toolbar';
import { stageIconTheme } from './stageIconTheme';
import { WatchBenchPanel } from './WatchBenchPanel';
import { createTreeCommit, publishTreeCommit } from '../../../scripts/watch-bench-render-lib.mjs';
import {
  planEditorTabOpen,
  settleEditorTabLoad,
  type EditorTab,
} from '../../../scripts/editor-tabs.mjs';
import type { PlaygroundFileAction } from '../../../scripts/file-actions.mjs';

interface ConnectionState {
  fx: PortFileExplorer;
  workspaceRoot: string;
}

const WELCOME = `// Project tool window
//
// Double-click a file to open it here.
// ⌘F / Ctrl+F — filter tree
// F2 — rename · Delete — delete
// Right-click — context menu
`;

const PLAYGROUND_ACTIVE_ENTRY_POLICY: ActiveEntryPolicy = Object.freeze({
  revealHidden: false,
  revealIgnored: false,
  revealGenerated: false,
});

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

  return <Explorer key={conn.workspaceRoot} fx={conn.fx} root={conn.workspaceRoot} />;
}

function Explorer({ fx, root }: { fx: PortFileExplorer; root: string }): ReactElement {
  const commands = useMemo(() => createCommandRegistry(defaultCommands), []);
  const treeRef = useFileTreeRef();
  const [fileActionStatus, setFileActionStatus] = useState<string | null>(null);
  const performFileAction = useCallback(
    async (target: FileActionTarget, action: PlaygroundFileAction): Promise<void> => {
      try {
        const result = await window.millePlayground.performFileAction({
          action,
          workspaceRoot: root,
          rootRelativePath: target.rootRelativePath,
        });
        const verb = action.startsWith('copy')
          ? 'Copied'
          : action === 'revealInFileManager'
            ? 'Revealed'
            : 'Opened';
        setFileActionStatus(`${verb}: ${result.value}`);
      } catch (error) {
        setFileActionStatus(
          `Action unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [root],
  );
  useEffect(() => {
    if (fileActionStatus === null) return;
    const timer = window.setTimeout(() => setFileActionStatus(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [fileActionStatus]);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const [initialNavigationState, setInitialNavigationState] = useState<string | null | undefined>(
    undefined,
  );
  useEffect(() => {
    let cancelled = false;
    void window.millePlayground
      .getFileTreeNavigationState(root)
      .then((state) => {
        if (!cancelled) setInitialNavigationState(state);
      })
      .catch((err: unknown) => {
        console.warn('[playground] navigation restore failed:', err);
        if (!cancelled) setInitialNavigationState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);
  const persistNavigationState = useCallback(
    (state: FileTreeNavigationState) => {
      const serialized = serializeFileTreeNavigationState(state);
      void window.millePlayground
        .saveFileTreeNavigationState(root, serialized)
        .then((saved) => {
          if (!saved) console.warn('[playground] navigation state was not persisted');
        })
        .catch((err: unknown) => {
          console.warn('[playground] navigation save failed:', err);
        });
    },
    [root],
  );
  const onTreeRender = useCallback<ProfilerOnRenderCallback>(
    (_id, phase, actualDuration, baseDuration, startTime, commitTime) => {
      publishTreeCommit(
        createTreeCommit(
          {
            phase,
            treeVersion: fx.getSnapshot().treeVersion,
            actualDurationMs: actualDuration,
            baseDurationMs: baseDuration,
            startTimeMs: startTime,
            commitTimeMs: commitTime,
          },
          performance.timeOrigin,
        ),
      );
    },
    [fx],
  );

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
  const [followActiveEditor, setFollowActiveEditor] = useState(true);
  const [singleClickPreview, setSingleClickPreview] = useState(true);

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
      preview: false,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState('welcome');
  const tabsRef = useRef<readonly EditorTab[]>(tabs);
  const loadRevisionRef = useRef(new Map<number, number>());

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!;

  const openEntry = useCallback(
    async (entry: Entry | VisibleRow, event: FileOpenEvent) => {
      if (entry.kind === 1) return;
      setEditorOpen(true);

      const plan = planEditorTabOpen(tabsRef.current, entry, event.mode);
      tabsRef.current = plan.tabs;
      setTabs([...plan.tabs]);
      setActiveTabId(plan.activeTabId);
      if (!plan.shouldLoad) return;

      const revision = (loadRevisionRef.current.get(entry.id) ?? 0) + 1;
      loadRevisionRef.current.set(entry.id, revision);

      try {
        const text = await fx.readText(entry.id);
        const body = typeof text === 'string' ? text : String(text ?? '');
        const capped = body.length > 120_000 ? `${body.slice(0, 120_000)}\n\n// … truncated` : body;
        const highlight = /\.(ts|tsx|js|jsx|mjs|cjs|json|rs|md|css|toml|yml|yaml)$/i.test(
          entry.name,
        );
        const next = settleEditorTabLoad(
          tabsRef.current,
          plan.activeTabId,
          capped,
          highlight,
          revision,
          loadRevisionRef.current.get(entry.id),
        );
        if (next === tabsRef.current) return;
        tabsRef.current = next;
        setTabs([...next]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const next = settleEditorTabLoad(
          tabsRef.current,
          plan.activeTabId,
          `// failed to read\n// ${msg}`,
          true,
          revision,
          loadRevisionRef.current.get(entry.id),
        );
        if (next === tabsRef.current) return;
        tabsRef.current = next;
        setTabs([...next]);
      }
    },
    [fx],
  );

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        const welcome: EditorTab = {
          id: 'welcome',
          title: 'Welcome',
          kind: 'welcome',
          body: WELCOME,
          highlighted: true,
          preview: false,
        };
        tabsRef.current = [welcome];
        setActiveTabId('welcome');
        setEditorOpen(false);
        return [welcome];
      }
      tabsRef.current = next;
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
        <WatchBenchPanel fx={fx} treeRef={treeRef} />
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
              title="Reveal active file"
              disabled={activeTab.entryId === undefined}
              onClick={() => {
                if (activeTab.entryId !== undefined) {
                  treeRef.current?.revealId(activeTab.entryId);
                }
              }}
            >
              ◎
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
                    followActiveEditor={followActiveEditor}
                    onFollowActiveEditorChange={setFollowActiveEditor}
                    singleClickPreview={singleClickPreview}
                    onSingleClickPreviewChange={setSingleClickPreview}
                    onReset={() => treeRef.current?.reset()}
                    compact
                  />
                </div>
              ) : null}
            </div>
          </div>

          {fileActionStatus ? (
            <div className="file-action-status" role="status" aria-live="polite">
              {fileActionStatus}
            </div>
          ) : null}

          <div
            className="tree-container"
            data-mille-theme={iconThemeId === 'minimal' ? 'minimal' : undefined}
          >
            <Profiler id="file-tree" onRender={onTreeRender}>
              {initialNavigationState === undefined ? (
                <div className="tree-navigation-loading" aria-busy="true">
                  Restoring project view…
                </div>
              ) : (
                <FileTree
                  ref={treeRef}
                  ariaLabel="Project"
                  iconTheme={iconTheme}
                  rowHeight={iconThemeId === 'minimal' ? 26 : 17}
                  overscan={36}
                  stickyRoots
                  showFilter={filterOpen}
                  searchMode="filter"
                  initialNavigationState={initialNavigationState}
                  onNavigationStateChange={persistNavigationState}
                  activeEntry={activeTab.entryId ?? null}
                  autoRevealActiveEntry={followActiveEditor}
                  activeEntryPolicy={PLAYGROUND_ACTIVE_ENTRY_POLICY}
                  openBehavior={{
                    singleClick: singleClickPreview ? 'preview' : 'select',
                  }}
                  onOpen={(row, event) => {
                    void openEntry(row, event);
                  }}
                  onCopyPath={(target, kind) =>
                    performFileAction(
                      target,
                      kind === 'absolute' ? 'copyAbsolutePath' : 'copyRelativePath',
                    )
                  }
                  onRevealInFileManager={(target) =>
                    performFileAction(target, 'revealInFileManager')
                  }
                  onOpenContainingFolder={(target) =>
                    performFileAction(target, 'openContainingFolder')
                  }
                  onOpenTerminal={(target) => performFileAction(target, 'openTerminal')}
                />
              )}
            </Profiler>
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
                  className={`tab${tab.id === activeTab.id ? ' is-active' : ''}${tab.preview ? ' is-preview' : ''}`}
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
