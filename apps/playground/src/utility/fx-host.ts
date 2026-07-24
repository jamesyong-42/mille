import { createFileExplorerHost } from '@vibecook/mille/host';
import type { FileExplorerHost, MessagePortLike } from '@vibecook/mille/host';
import type { MessagePortMain } from 'electron';
import { registerGitDecorations, type GitDecorationsHandle } from '@vibecook/mille-ui/git';
import { createShellGitClient } from '@vibecook/mille-ui/git/node';
import { parseWorkspaceRoots } from '../../scripts/workspace-roots.mjs';
import {
  createMapDiagnosticsClient,
  registerDiagnosticsDecorations,
  type DiagnosticsDecorationsHandle,
} from '@vibecook/mille-ui/diagnostics';
import {
  createMapTestStatusClient,
  registerTestStatusDecorations,
  type TestStatusDecorationsHandle,
} from '@vibecook/mille-ui/test-status';
import {
  demoDiagnosticsSeed,
  demoTestStatusSeed,
} from '../shared/demo-explorer-data';

// Electron's MessagePortMain emits `message` events with a MessageEvent-
// shaped object ({ data, ports }). The mille library's built-in adapter
// assumes node:worker_threads semantics where `.on('message', raw => ...)`
// hands the listener the raw payload directly. We normalize both quirks:
//
//  1. Unwrap Electron's MessageEvent so the library sees `{ data: raw }`
//     instead of `{ data: { data: raw, ports: [...] } }`.
//  2. Call `port.postMessage(msg)` with NO second argument when the
//     transfer list is empty — Electron's MessagePortMain silently drops
//     messages when called as `.postMessage(msg, undefined)`, which the
//     library would otherwise do on every non-transferring send.
function wrapMessagePortMain(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener: (_type, listener) => {
      port.on('message', (evt) => listener({ data: evt.data }));
    },
    removeEventListener: () => {
      /* library only attaches a single listener per port */
    },
    postMessage: (msg, transfer) => {
      if (transfer && (transfer as unknown[]).length > 0) {
        port.postMessage(msg, transfer as MessagePortMain[]);
      } else {
        port.postMessage(msg);
      }
    },
    start: () => port.start(),
    close: () => port.close(),
  };
}

let host: FileExplorerHost | null = null;
/** One handle per workspace root — git status is per repository. */
let gitDecorations: GitDecorationsHandle[] = [];
let diagnosticsDecorations: DiagnosticsDecorationsHandle | null = null;
let testStatusDecorations: TestStatusDecorationsHandle | null = null;

// v0.2 — the shell git client needs `node:child_process`, so it
// cannot live in the renderer. Register it here against the
// in-process FileExplorer; A1's decoration fan-out carries badges to
// every attached port session automatically. Controlled via the
// `set-git-decorations` IPC message from main → utility.
function setGitDecorations(enabled: boolean, rootPaths: readonly string[]): void {
  if (!host) return;
  if (!enabled) {
    for (const handle of gitDecorations) handle.dispose();
    gitDecorations = [];
    console.log('[fx-host] git decorations disabled');
    return;
  }
  if (gitDecorations.length > 0) return; // already on — idempotent
  try {
    const currentHost = host;
    const currentFx = host.local;
    gitDecorations = rootPaths.map((rootPath) =>
      registerGitDecorations({
        fx: currentFx, // read path (getSnapshot, getByUri)
        client: createShellGitClient({ rootPath }),
        rootPath,
        // Each root gets its own provider id: the default 'scm' would make
        // the second root's provider replace the first in the decoration
        // store. Entry lookup is by absolute URI, so the two providers
        // decorate disjoint subtrees.
        providerId: `scm:${rootPath}`,
        // Critical: register against the *host's* DecorationStore, not
        // `host.local`'s. `host.local.registerDecorationProvider` has
        // its own independent store that never reaches attached port
        // sessions — decorations would place but never fan out. The
        // host's store is what the per-session tick observes.
        registrar: (provider) => currentHost.registerDecorationProvider(provider),
      }),
    );
    console.log(
      `[fx-host] git decorations enabled for ${rootPaths.length} root(s)`,
    );
    // Re-register diagnostics after SCM so problem badges win the
    // shared badge slot (later providers win on overlapping fields).
    // Demo diagnostics seed paths are primary-root relative; re-register
    // against that root only.
    if (process.env.MILLE_DEMO_DIAGNOSTICS !== '0' && rootPaths[0] !== undefined) {
      diagnosticsDecorations?.dispose();
      diagnosticsDecorations = null;
      setDiagnosticsDecorations(true, rootPaths[0]);
    }
  } catch (err) {
    console.warn('[fx-host] failed to enable git decorations:', err);
  }
}

/**
 * Phase 5.1 — demo diagnostics decorations. Seeds a few problems on
 * well-known monorepo paths so the explorer shows problem-count badges
 * without a real language server. Real hosts should swap this for an
 * LSP-backed `DiagnosticsClient`.
 *
 * Registered *after* SCM (when both are on) so diagnostic badges win
 * the shared badge slot via later-wins merge.
 */
function setDiagnosticsDecorations(enabled: boolean, rootPath: string): void {
  if (!host) return;
  if (!enabled) {
    diagnosticsDecorations?.dispose();
    diagnosticsDecorations = null;
    console.log('[fx-host] diagnostics decorations disabled');
    return;
  }
  if (diagnosticsDecorations !== null) return;
  try {
    const client = createMapDiagnosticsClient({
      initial: demoDiagnosticsSeed(),
    });
    const currentHost = host;
    diagnosticsDecorations = registerDiagnosticsDecorations({
      fx: host.local,
      client,
      rootPath,
      registrar: (provider) => currentHost.registerDecorationProvider(provider),
    });
    console.log('[fx-host] diagnostics decorations enabled (demo seed)');
  } catch (err) {
    console.warn('[fx-host] failed to enable diagnostics decorations:', err);
  }
}

/**
 * Phase 5.1 — demo test-status decorations. Seeds a few suite outcomes
 * on well-known test paths. Opt out with MILLE_DEMO_TEST_STATUS=0.
 */
function setTestStatusDecorations(enabled: boolean, rootPath: string): void {
  if (!host) return;
  if (!enabled) {
    testStatusDecorations?.dispose();
    testStatusDecorations = null;
    console.log('[fx-host] test-status decorations disabled');
    return;
  }
  if (testStatusDecorations !== null) return;
  try {
    const client = createMapTestStatusClient({
      initial: [...demoTestStatusSeed()],
    });
    const currentHost = host;
    testStatusDecorations = registerTestStatusDecorations({
      fx: host.local,
      client,
      rootPath,
      showPassed: true, // demo should show green checks too
      registrar: (provider) => currentHost.registerDecorationProvider(provider),
    });
    console.log('[fx-host] test-status decorations enabled (demo seed)');
  } catch (err) {
    console.warn('[fx-host] failed to enable test-status decorations:', err);
  }
}

async function bootstrap(): Promise<void> {
  const root = process.env.WORKSPACE_ROOT;
  if (!root) throw new Error('WORKSPACE_ROOT env var not set');
  // WORKSPACE_ROOTS carries the whole workspace; WORKSPACE_ROOT stays the
  // primary root for the single-root paths (watch bench, demo seeds).
  const roots = parseWorkspaceRoots(process.env.WORKSPACE_ROOTS, root);

  const benchmarkDebounce = Number(process.env.MILLE_WATCH_BENCH_DEBOUNCE_MS);
  host = await createFileExplorerHost({
    roots,
    respectIgnore: true,
    followSymlinks: 'smart',
    watchDebounceMs:
      Number.isSafeInteger(benchmarkDebounce) && benchmarkDebounce >= 0 ? benchmarkDebounce : 75,
    // v0.2 B2 — `roots-only` seeds just the workspace root(s) at
    // attach time; the host's `handleSetExpanded` fires a depth-1
    // prefetch per newly-expanded folder. Huge monorepos (pnpm
    // stores, giant node_modules) no longer walk upfront.
    // `excludeGlobs` hack is gone — lazy expansion + gitignore is
    // enough. B3 will fix the underlying symlink-descent issue so
    // even expanding into a pnpm `node_modules` stays responsive.
    initialWalk: 'roots-only',
  });

  // Register the attach handler BEFORE kicking off the initial walk.
  // If populate ran first, a slow root would block the handler from
  // being installed and the renderer's handshake would look stuck.
  process.parentPort.on('message', (evt) => {
    const msg = evt.data as { type?: string; enabled?: boolean } | undefined;
    const port = evt.ports[0];
    console.log(
      `[fx-host] main → fx-host: ${msg?.type ?? '<unknown>'} (ports: ${evt.ports.length})`,
    );
    if (msg?.type === 'attach' && port) {
      host!.attachPort(wrapMessagePortMain(port));
      console.log('[fx-host] attachPort done');
      return;
    }
    if (msg?.type === 'set-git-decorations') {
      setGitDecorations(!!msg.enabled, roots);
      return;
    }
    if (msg?.type === 'set-diagnostics-decorations') {
      setDiagnosticsDecorations(!!msg.enabled, root);
      return;
    }
  });

  // Phase 5.1 — enable demo diagnostics by default so problem badges
  // are visible without a UI toggle. Opt out with
  // MILLE_DEMO_DIAGNOSTICS=0. If git decorations enable later, they
  // re-register diagnostics after SCM so problem badges win the merge.
  if (process.env.MILLE_DEMO_DIAGNOSTICS !== '0') {
    setDiagnosticsDecorations(true, root);
  }
  if (process.env.MILLE_DEMO_TEST_STATUS !== '0') {
    setTestStatusDecorations(true, root);
  }

  // Fixed in v0.2 B1 — roots now ship in deltas so the handshake can
  // fire immediately; the walker fills the tree in the background.
  //
  // Previously (v0.1) the `snapshot` frame was the only wire-path for
  // `roots`, so handshaking before the walker had added the root entry
  // left the client with `roots: []` forever (tree stayed blank even as
  // treeVersion climbed). The workaround was to `await populateFromRoots`
  // before sending 'ready', which blocked the renderer on "Connecting…"
  // for 10-60s on large monorepos. B1's delta-piggybacked roots field
  // means the client learns the root as soon as the walker discovers it
  // — no reason to block the handshake anymore.
  process.parentPort.postMessage({ type: 'ready' });
  console.log('[fx-host] ready sent to main');
  // No eager walk. `initialWalk: 'roots-only'` seeds the root entry
  // when the first client attaches; children are prefetched on
  // demand via handleSetExpanded. See v0.2 B2 in V0_2_PLAN.md.
}

bootstrap().catch((err) => {
  console.error('[playground] fx-host bootstrap failed:', err);
  process.exit(1);
});

process.on('exit', () => {
  if (host) void host.dispose();
});
