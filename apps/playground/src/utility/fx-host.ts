import { createFileExplorerHost } from '@vibecook/mille/host';
import type { FileExplorerHost, MessagePortLike } from '@vibecook/mille/host';
import type { MessagePortMain } from 'electron';
import { registerGitDecorations, type GitDecorationsHandle } from '@vibecook/mille-ui/git';
import { createShellGitClient } from '@vibecook/mille-ui/git/node';

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
let gitDecorations: GitDecorationsHandle | null = null;

// v0.2 — the shell git client needs `node:child_process`, so it
// cannot live in the renderer. Register it here against the
// in-process FileExplorer; A1's decoration fan-out carries badges to
// every attached port session automatically. Controlled via the
// `set-git-decorations` IPC message from main → utility.
function setGitDecorations(enabled: boolean, rootPath: string): void {
  if (!host) return;
  if (!enabled) {
    gitDecorations?.dispose();
    gitDecorations = null;
    console.log('[fx-host] git decorations disabled');
    return;
  }
  if (gitDecorations !== null) return; // already on — idempotent
  try {
    const client = createShellGitClient({ rootPath });
    const currentHost = host;
    gitDecorations = registerGitDecorations({
      fx: host.local, // read path (getSnapshot, getByUri)
      client,
      rootPath,
      // Critical: register against the *host's* DecorationStore, not
      // `host.local`'s. `host.local.registerDecorationProvider` has
      // its own independent store that never reaches attached port
      // sessions — decorations would place but never fan out. The
      // host's store is what the per-session tick observes.
      registrar: (provider) => currentHost.registerDecorationProvider(provider),
    });
    console.log('[fx-host] git decorations enabled');
  } catch (err) {
    console.warn('[fx-host] failed to enable git decorations:', err);
  }
}

async function bootstrap(): Promise<void> {
  const root = process.env.WORKSPACE_ROOT;
  if (!root) throw new Error('WORKSPACE_ROOT env var not set');

  const benchmarkDebounce = Number(process.env.MILLE_WATCH_BENCH_DEBOUNCE_MS);
  host = await createFileExplorerHost({
    roots: [root],
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
      setGitDecorations(!!msg.enabled, root);
      return;
    }
  });

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
