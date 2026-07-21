import { app, type BrowserWindow, type UtilityProcess, utilityProcess } from 'electron';
import { join } from 'node:path';

import type {
  WatchBenchConfig,
  WatchBenchEvent,
  WatchBenchObservation,
} from '../shared/watch-bench';

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function watchBenchConfigFromEnvironment(): WatchBenchConfig | null {
  if (process.env.MILLE_WATCH_BENCH !== '1') return null;
  const workspaceRoot = process.env.MILLE_WATCH_BENCH_ROOT;
  const reportPath = process.env.MILLE_WATCH_BENCH_REPORT;
  if (!workspaceRoot || !reportPath) {
    throw new Error('MILLE_WATCH_BENCH requires root and report paths');
  }
  return {
    enabled: true,
    operations: positiveInteger(process.env.MILLE_WATCH_BENCH_OPERATIONS, 240),
    debounceMs: nonNegativeInteger(process.env.MILLE_WATCH_BENCH_DEBOUNCE_MS, 40),
    timeoutMs: positiveInteger(process.env.MILLE_WATCH_BENCH_TIMEOUT_MS, 5_000),
    pauseMs: nonNegativeInteger(process.env.MILLE_WATCH_BENCH_PAUSE_MS, 0),
    exitOnComplete: process.env.MILLE_WATCH_BENCH_EXIT_ON_COMPLETE === '1',
    reportPath,
    workspaceRoot,
  };
}

export class WatchBenchController {
  private worker: UtilityProcess | null = null;
  private started = false;

  constructor(
    private readonly win: BrowserWindow,
    readonly config: WatchBenchConfig,
  ) {}

  start(): void {
    if (this.started || this.win.isDestroyed()) return;
    this.started = true;
    const workerPath = join(app.getAppPath(), 'scripts', 'watch-bench-worker.mjs');
    const worker = utilityProcess.fork(workerPath, [], {
      serviceName: 'mille-watch-benchmark-operator',
      stdio: 'pipe',
      env: {
        ...process.env,
        MILLE_WATCH_BENCH_ROOT: this.config.workspaceRoot,
        MILLE_WATCH_BENCH_REPORT: this.config.reportPath,
        MILLE_WATCH_BENCH_OPERATIONS: String(this.config.operations),
        MILLE_WATCH_BENCH_PAUSE_MS: String(this.config.pauseMs),
        MILLE_WATCH_BENCH_TIMEOUT_MS: String(this.config.timeoutMs),
      },
    });
    this.worker = worker;
    worker.stdout?.on('data', (data) => process.stdout.write(`[watch-bench] ${data}`));
    worker.stderr?.on('data', (data) => process.stderr.write(`[watch-bench] ${data}`));
    worker.on('message', (message: unknown) => {
      if (this.win.isDestroyed()) return;
      this.win.webContents.send('watch-bench:event', message as WatchBenchEvent);
      if (
        this.config.exitOnComplete &&
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        (message.type === 'complete' || message.type === 'fatal')
      ) {
        setTimeout(() => app.quit(), 300);
      }
    });
    worker.on('exit', (code) => {
      if (code !== 0 && code !== null && !this.win.isDestroyed()) {
        this.win.webContents.send('watch-bench:event', {
          type: 'fatal',
          message: `benchmark operation worker exited with code ${code}`,
        } satisfies WatchBenchEvent);
      }
      if (this.worker === worker) this.worker = null;
    });
  }

  observe(observation: WatchBenchObservation): void {
    this.worker?.postMessage({ type: 'observed', observation });
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) {
      try {
        worker.kill();
      } catch {
        // Already stopped.
      }
    }
  }
}
