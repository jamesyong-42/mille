import { createFileExplorerHost } from '@vibecook/mille/host';
import type { FileExplorerHost, MessagePortLike } from '@vibecook/mille/host';
import type { MessagePortMain } from 'electron';

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

async function bootstrap(): Promise<void> {
  const root = process.env.WORKSPACE_ROOT;
  if (!root) throw new Error('WORKSPACE_ROOT env var not set');

  host = await createFileExplorerHost({
    roots: [root],
    respectIgnore: true,
    followSymlinks: 'smart',
    watchDebounceMs: 75,
  });

  // Register the attach handler BEFORE kicking off the initial walk.
  // If populate ran first, a slow root (huge $HOME etc.) would block
  // the handler from being installed and the renderer's handshake
  // would look stuck. By attaching first, the initial snapshot frame
  // flows immediately (even if mostly empty), and freshly-walked rows
  // arrive as coalesced deltas. The renderer is responsive during
  // the walk instead of frozen on a spinner.
  process.parentPort.on('message', (evt) => {
    const msg = evt.data as { type?: string } | undefined;
    const port = evt.ports[0];
    if (msg?.type === 'attach' && port) {
      host!.attachPort(wrapMessagePortMain(port));
    }
  });

  console.log(`[fx-host] walking ${root} …`);
  const t0 = Date.now();
  await host.local.populateFromRoots();
  console.log(`[fx-host] initial walk done in ${Date.now() - t0}ms`);
}

bootstrap().catch((err) => {
  console.error('[playground] fx-host bootstrap failed:', err);
  process.exit(1);
});

process.on('exit', () => {
  if (host) void host.dispose();
});
