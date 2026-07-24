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
  fileTreePathForId,
  serializeFileTreeNavigationState,
  useFileTreeRef,
  type ActiveEntryPolicy,
  type FileActionTarget,
  type FileOpenEvent,
  type FileRefreshTarget,
  type FileSearchRequest,
  type FileTreeNavigationState,
} from '@vibecook/mille-ui';
import {
  createMapEditorStateClient,
  registerEditorStateDecorations,
  type EditorTabState,
  type MapEditorStateClient,
} from '@vibecook/mille-ui/editor-state';
import {
  ExplorerViewList,
  projectChangedFilesView,
  projectFailedTestsView,
  projectOpenFilesView,
  projectProblemsView,
  resolveExplorerView,
  type ExplorerViewKind,
  type ExplorerViewModel,
} from '@vibecook/mille-ui/views';
import type { GitStatusEntry, GitStatusLetter } from '@vibecook/mille-ui/git';
import type { TestResult } from '@vibecook/mille-ui/test-status';
import type { IconTheme } from '@vibecook/mille-ui/icons';
import { defaultIconTheme, duotoneIconTheme, minimalIconTheme } from '@vibecook/mille-ui/icons';
import { createCommandRegistry, defaultCommands } from '@vibecook/mille-ui/commands';
import {
  scmHistoryCommands,
  type FileHistoryRevision,
  type ScmClient,
  type ScmCompareResult,
  type ScmHostHooks,
} from '@vibecook/mille-ui/history';
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

type SidebarView = Extract<
  ExplorerViewKind,
  'project' | 'openFiles' | 'changedFiles' | 'problems' | 'failedTests'
>;

const SIDEBAR_VIEWS: ReadonlyArray<{ kind: SidebarView; label: string }> = [
  { kind: 'project', label: 'Project' },
  { kind: 'openFiles', label: 'Open Files' },
  { kind: 'changedFiles', label: 'Changed Files' },
  { kind: 'problems', label: 'Problems' },
  { kind: 'failedTests', label: 'Failed Tests' },
];

const GIT_LETTERS = new Set(['M', 'A', 'D', 'U', 'R', 'C', '?', '!']);

function asGitStatusEntries(
  raw: ReadonlyArray<{ path: string; status: string; staged?: boolean }>,
): GitStatusEntry[] {
  const out: GitStatusEntry[] = [];
  for (const e of raw) {
    if (!GIT_LETTERS.has(e.status)) continue;
    out.push({
      path: e.path,
      status: e.status as GitStatusLetter,
      ...(e.staged === true ? { staged: true } : {}),
    });
  }
  return out;
}

/** Demo failed-tests seed (mirrors utility-process test-status decorations). */
function demoFailedTests(): TestResult[] {
  return [
    {
      path: 'packages/mille/test/undo-journal.test.mjs',
      status: 'failed',
      message: 'Demo: simulated assertion failure',
    },
    {
      path: 'packages/mille-ui/test/editor-state-decorations.test.mjs',
      status: 'running',
    },
    {
      path: 'packages/mille-ui/test/diagnostics-decorations.test.mjs',
      status: 'passed',
    },
  ];
}

/** Demo problems mirror of the utility-process diagnostics seed (Phase 5.1). */
function demoProblemsMap(): Map<
  string,
  ReadonlyArray<{ path: string; severity: 'error' | 'warning' | 'info' | 'hint'; message?: string }>
> {
  return new Map([
    [
      'packages/mille-ui/package.json',
      [
        {
          path: 'packages/mille-ui/package.json',
          severity: 'warning',
          message: 'Demo: consider pinning peerDependency ranges',
        },
      ],
    ],
    [
      'packages/mille-ui/src/index.ts',
      [
        {
          path: 'packages/mille-ui/src/index.ts',
          severity: 'error',
          message: "Demo: Cannot find name 'example'",
        },
        {
          path: 'packages/mille-ui/src/index.ts',
          severity: 'warning',
          message: 'Demo: unused export surface',
        },
      ],
    ],
    [
      'planning/IDE_EXPLORER_PARITY_PLAN.md',
      [
        {
          path: 'planning/IDE_EXPLORER_PARITY_PLAN.md',
          severity: 'info',
          message: 'Demo: Phase 5.2 views',
        },
      ],
    ],
  ]);
}

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
  const commands = useMemo(
    () => createCommandRegistry([...defaultCommands, ...scmHistoryCommands]),
    [],
  );
  const treeRef = useFileTreeRef();
  const [fileActionStatus, setFileActionStatus] = useState<string | null>(null);
  const [historyPanel, setHistoryPanel] = useState<{
    path: string;
    revisions: readonly FileHistoryRevision[];
  } | null>(null);
  const [comparePanel, setComparePanel] = useState<ScmCompareResult | null>(null);
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
  const refreshFromDisk = useCallback(
    async (target: FileRefreshTarget): Promise<void> => {
      try {
        if (target.kind === 'workspace') {
          await fx.resyncWorkspace();
          setFileActionStatus('Workspace refreshed from disk');
        } else {
          await fx.resync(target.id, { recursive: true });
          setFileActionStatus('Subtree refreshed from disk');
        }
      } catch (error) {
        setFileActionStatus(
          `Refresh unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [fx],
  );
  const handoffSearchScope = useCallback((request: FileSearchRequest): void => {
    const paths = request.targets.map((target) => target.rootQualifiedPath).join(', ');
    const label =
      request.kind === 'findInFolder'
        ? 'Find in folder'
        : request.kind === 'include'
          ? 'Search include'
          : 'Search exclude';
    setFileActionStatus(`${label}: ${paths}`);
  }, []);
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

  // Phase 5.3 — SCM/history host hooks (IPC to main-process shell git).
  // Declared after editorOpen so compare can open the secondary pane.
  const scmHostHooks = useMemo((): ScmHostHooks => {
    const scm: ScmClient = {
      async revert(paths, options) {
        await window.millePlayground.scmRevert(paths, options?.rootPath ?? root);
      },
      async compare(request) {
        return window.millePlayground.scmCompare({
          path: request.path,
          rootPath: request.rootPath ?? root,
          left: request.left,
          right: request.right,
        });
      },
    };
    return {
      scm,
      history: {
        async getHistory(query) {
          return window.millePlayground.getFileHistory(query.path, {
            rootPath: query.rootPath ?? root,
            limit: query.limit,
          });
        },
      },
      confirm: (message) => window.confirm(message),
      onProgress: (event) => {
        if (event.phase === 'completed' || event.phase === 'failed') {
          setFileActionStatus(`${event.action}: ${event.message ?? event.phase}`);
        }
      },
      onError: (error, ctx) => {
        setFileActionStatus(
          `${ctx.action} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
      onCompareResult: (result) => {
        setComparePanel(result);
        setHistoryPanel(null);
        setEditorOpen(true);
        setFileActionStatus(`Compare ${result.path}: ${result.leftLabel} ↔ ${result.rightLabel}`);
      },
      onHistoryResult: (path, revisions) => {
        setHistoryPanel({ path, revisions });
        setComparePanel(null);
        setEditorOpen(true);
        setFileActionStatus(`History ${path}: ${revisions.length} revision(s)`);
      },
    };
  }, [root]);

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
  const [sidebarView, setSidebarView] = useState<SidebarView>('project');
  const [viewModel, setViewModel] = useState<ExplorerViewModel | null>(null);
  const tabsRef = useRef<readonly EditorTab[]>(tabs);
  const loadRevisionRef = useRef(new Map<number, number>());
  const editorStateClientRef = useRef<MapEditorStateClient | null>(null);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!;

  // Phase 5.1 — open/dirty/active decorations from the playground editor tabs.
  // Registered against the port client (renderer-side decoration push).
  useEffect(() => {
    const client = createMapEditorStateClient();
    editorStateClientRef.current = client;
    const handle = registerEditorStateDecorations({
      fx,
      client,
      rootPath: root,
      // Hollow open circles are noisy next to SCM; only mark dirty for now.
      // Active still gets a tooltip when dirty or when we later enable open dots.
      decorateOpen: false,
    });
    return () => {
      handle.dispose();
      editorStateClientRef.current = null;
    };
  }, [fx, root]);

  /** Build open-tab seeds with EntryId + rootPath (multi-root safe). */
  const buildOpenTabs = useCallback((): {
    open: EditorTabState[];
    activePath: string | null;
  } => {
    const snap = fx.getSnapshot();
    const open: EditorTabState[] = [];
    let activePath: string | null = null;
    for (const tab of tabs) {
      if (tab.kind !== 'file' || tab.entryId == null) continue;
      const treePath = fileTreePathForId(snap, tab.entryId);
      // Prefer EntryId even when path projection fails (lazy / multi-root).
      let rel = '';
      if (treePath !== null) {
        const slash = treePath.indexOf('/');
        rel = slash === -1 ? '' : treePath.slice(slash + 1);
      }
      if (rel.length === 0) {
        // Fall back to tab title as a display path; id still identifies the entry.
        rel = tab.title || `entry:${tab.entryId}`;
      }
      open.push({
        path: rel,
        rootPath: root,
        entryId: tab.entryId,
        dirty: false,
        active: tab.id === activeTabId,
        title: tab.title,
      });
      if (tab.id === activeTabId) activePath = rel;
    }
    return { open, activePath };
  }, [fx, tabs, activeTabId, root]);

  useEffect(() => {
    const client = editorStateClientRef.current;
    if (!client) return;
    const { open, activePath } = buildOpenTabs();
    client.setTabs(open, activePath);
  }, [buildOpenTabs]);

  // Phase 5.2 — materialize Open Files / Problems; refresh on tree churn.
  useEffect(() => {
    if (sidebarView === 'project') {
      setViewModel(null);
      return;
    }
    let cancelled = false;
    let generation = 0;

    const materialize = async () => {
      const gen = ++generation;
      if (sidebarView === 'openFiles') {
        const { open, activePath } = buildOpenTabs();
        const definition = projectOpenFilesView({ open, activePath });
        const model = await resolveExplorerView({
          fx,
          rootPath: root,
          definition,
        });
        if (!cancelled && gen === generation) setViewModel(model);
        return;
      }
      if (sidebarView === 'problems') {
        // Demo seed until a live diagnostics bridge is available; still
        // re-resolve when the tree snapshot changes so ids refresh.
        const definition = projectProblemsView(demoProblemsMap(), {
          minSeverity: 'info',
        });
        const model = await resolveExplorerView({
          fx,
          rootPath: root,
          definition,
        });
        if (!cancelled && gen === generation) setViewModel(model);
        return;
      }
      if (sidebarView === 'changedFiles') {
        let entries: GitStatusEntry[] = [];
        try {
          const raw = await window.millePlayground.getGitStatus(root);
          entries = asGitStatusEntries(raw);
        } catch (err) {
          console.warn('[playground] getGitStatus failed:', err);
        }
        const definition = projectChangedFilesView(entries);
        const model = await resolveExplorerView({
          fx,
          rootPath: root,
          definition,
        });
        if (!cancelled && gen === generation) setViewModel(model);
        return;
      }
      if (sidebarView === 'failedTests') {
        // Default projector keeps failed+errored; include running for demo.
        const definition = projectFailedTestsView(demoFailedTests(), {
          statuses: ['failed', 'errored', 'running'],
          title: 'Failed Tests',
        });
        const model = await resolveExplorerView({
          fx,
          rootPath: root,
          definition,
        });
        if (!cancelled && gen === generation) setViewModel(model);
      }
    };

    void materialize();

    // Re-resolve when the engine publishes tree/decoration deltas so renames,
    // deletes, and newly hydrated paths refresh the view.
    const unsubTree =
      typeof fx.on === 'function'
        ? fx.on('change:tree', () => {
            void materialize();
          })
        : null;
    const unsub =
      typeof fx.on === 'function'
        ? fx.on('change', () => {
            void materialize();
          })
        : null;

    return () => {
      cancelled = true;
      generation += 1;
      try {
        unsubTree?.dispose?.();
      } catch {
        /* ignore */
      }
      try {
        unsub?.dispose?.();
      } catch {
        /* ignore */
      }
    };
  }, [fx, root, sidebarView, buildOpenTabs]);

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
  const sidebarTitle =
    SIDEBAR_VIEWS.find((v) => v.kind === sidebarView)?.label ?? 'Project';

  const cycleSidebarView = useCallback(() => {
    setSidebarView((current) => {
      const idx = SIDEBAR_VIEWS.findIndex((v) => v.kind === current);
      const next = SIDEBAR_VIEWS[(idx + 1) % SIDEBAR_VIEWS.length];
      return next?.kind ?? 'project';
    });
  }, []);

  return (
    <FileTreeProvider fx={fx as unknown as FileExplorer} commands={commands}>
      <div className={`app${editorOpen ? ' app--split' : ' app--project'}`}>
        <WatchBenchPanel fx={fx} treeRef={treeRef} />
        {/* ── Project tool window ─────────────────────────────── */}
        <aside className="sidebar">
          <div className="tool-header">
            <button
              type="button"
              className="tool-header-title tool-header-title-btn"
              title="Cycle view: Project → Open Files → Changed → Problems → Failed Tests"
              onClick={cycleSidebarView}
            >
              {sidebarTitle}
              <span className="tool-header-view" aria-hidden="true">
                ▾
              </span>
            </button>
            <span className="tool-header-meta" title={root}>
              {workspaceLabel}
            </span>
            {sidebarView === 'project' ? (
              <>
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
                  title="Refresh workspace from disk"
                  onClick={() => {
                    void refreshFromDisk({ kind: 'workspace' });
                  }}
                >
                  ↻
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
              </>
            ) : null}
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
            {sidebarView !== 'project' && viewModel ? (
              <ExplorerViewList
                model={viewModel}
                ariaLabel={viewModel.title}
                rowHeight={iconThemeId === 'minimal' ? 26 : 17}
                emptyState={
                  <div className="tree-navigation-loading">
                    {sidebarView === 'openFiles'
                      ? 'No open files — open a file from the Project view'
                      : sidebarView === 'changedFiles'
                        ? 'Working tree clean'
                        : sidebarView === 'failedTests'
                          ? 'No failed tests'
                          : 'No problems'}
                  </div>
                }
                onOpen={(item) => {
                  if (item.id === null) return;
                  const entry = fx.getSnapshot().getById(item.id);
                  if (entry === null) return;
                  void openEntry(entry, {
                    mode: 'permanent',
                    source: 'command',
                  });
                  setSidebarView('project');
                  requestAnimationFrame(() => {
                    treeRef.current?.revealId(item.id!);
                  });
                }}
              />
            ) : null}
            {sidebarView === 'project' ? (
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
                  hostHooks={scmHostHooks as ScmHostHooks & Record<string, unknown>}
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
                  onRefresh={refreshFromDisk}
                  onSearchScope={handoffSearchScope}
                />
              )}
            </Profiler>
            ) : null}
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
              {historyPanel ? (
                <button
                  type="button"
                  role="tab"
                  className="tab is-active"
                  onClick={() => setHistoryPanel(null)}
                  title="Close history panel"
                >
                  History · {historyPanel.path} ×
                </button>
              ) : null}
              {comparePanel ? (
                <button
                  type="button"
                  role="tab"
                  className="tab is-active"
                  onClick={() => setComparePanel(null)}
                  title="Close compare panel"
                >
                  Diff · {comparePanel.path} ×
                </button>
              ) : null}
            </div>
            <div className="code-panel">
              {historyPanel ? (
                <div className="history-panel" aria-label="File history">
                  <ol className="history-list">
                    {historyPanel.revisions.map((rev) => (
                      <li key={rev.id} className="history-item">
                        <code className="history-sha">{rev.shortId ?? rev.id.slice(0, 7)}</code>
                        <span className="history-msg">{rev.message ?? '(no message)'}</span>
                        <span className="history-meta">
                          {rev.author ?? ''}
                          {rev.timestampMs
                            ? ` · ${new Date(rev.timestampMs).toLocaleString()}`
                            : ''}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {historyPanel.revisions.length === 0 ? (
                    <div className="code-error">No history for {historyPanel.path}</div>
                  ) : null}
                </div>
              ) : comparePanel ? (
                <div className="compare-panel" aria-label="Compare revisions">
                  <div className="compare-col">
                    <div className="compare-label">{comparePanel.leftLabel}</div>
                    <pre className="code-scroll">
                      {typeof comparePanel.left === 'string'
                        ? comparePanel.left
                        : comparePanel.left === null
                          ? '(unavailable)'
                          : '[binary]'}
                    </pre>
                  </div>
                  <div className="compare-col">
                    <div className="compare-label">{comparePanel.rightLabel}</div>
                    <pre className="code-scroll">
                      {typeof comparePanel.right === 'string'
                        ? comparePanel.right
                        : comparePanel.right === null
                          ? '(unavailable)'
                          : '[binary]'}
                    </pre>
                  </div>
                </div>
              ) : activeTab.body.startsWith('// failed') ? (
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
