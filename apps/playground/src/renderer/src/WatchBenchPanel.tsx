import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { PortFileExplorer } from '@vibecook/mille/port';

import type {
  WatchBenchConfig,
  WatchBenchEvent,
  WatchBenchLatencySummary,
  WatchBenchOperation,
  WatchBenchSummary,
} from '../../shared/watch-bench';
import {
  createRenderObservation,
  isCommitEligible,
  isReferenceTreeReady,
  latestTreeCommit,
  subscribeTreeCommits,
  type RenderObservation,
  type TreeCommitMetric,
} from '../../../scripts/watch-bench-render-lib.mjs';

interface PendingOperation {
  readonly operation: WatchBenchOperation;
  readonly completedAt: number;
  readonly warmup: boolean;
}

interface AwaitingCommit {
  readonly pending: PendingOperation;
  readonly mirrorAt: number;
  readonly mirrorTreeVersion: number;
}

type Sample = RenderObservation;

function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function summarize(values: readonly number[]): WatchBenchLatencySummary {
  if (values.length === 0) return { min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
}

export function WatchBenchPanel({
  fx,
  treeRef,
}: {
  fx: PortFileExplorer;
  treeRef: { readonly current: { expand(ids: readonly number[]): void } | null };
}): ReactElement | null {
  const [config, setConfig] = useState<WatchBenchConfig | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [failed, setFailed] = useState(0);
  const [current, setCurrent] = useState<WatchBenchOperation | null>(null);
  const [complete, setComplete] = useState<WatchBenchSummary | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const configRef = useRef<WatchBenchConfig | null>(null);
  const expandedRef = useRef(new Set<number>());
  const pendingRef = useRef(new Map<number, PendingOperation>());
  const awaitingCommitRef = useRef(new Map<number, AwaitingCommit>());
  const reportingRef = useRef(new Set<number>());
  const readySentRef = useRef(false);
  const readyScheduledRef = useRef(false);
  const hydrationWindowRef = useRef<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;

    const observeAfterCommit = (
      id: number,
      awaiting: AwaitingCommit,
      commit: TreeCommitMetric,
    ): void => {
      if (!awaitingCommitRef.current.delete(id)) return;
      requestAnimationFrame((firstFrameTime) => {
        requestAnimationFrame((secondFrameTime) => {
          if (!aliveRef.current) return;
          const sample = createRenderObservation({
            id,
            kind: awaiting.pending.operation.kind,
            operationCompletedAt: awaiting.pending.completedAt,
            mirrorAt: awaiting.mirrorAt,
            mirrorTreeVersion: awaiting.mirrorTreeVersion,
            commit,
            firstFrameAt: performance.timeOrigin + firstFrameTime,
            secondFrameAt: performance.timeOrigin + secondFrameTime,
          });
          pendingRef.current.delete(id);
          reportingRef.current.delete(id);
          if (!awaiting.pending.warmup) setSamples((previous) => [...previous, sample]);
          window.millePlayground.reportWatchBenchObservation(sample);
        });
      });
    };

    const onTreeCommit = (commit: TreeCommitMetric): void => {
      for (const [id, awaiting] of awaitingCommitRef.current) {
        if (isCommitEligible(commit, awaiting.pending.completedAt, awaiting.mirrorTreeVersion)) {
          observeAfterCommit(id, awaiting, commit);
        }
      }
    };
    const unsubscribeCommits = subscribeTreeCommits(onTreeCommit);

    const expandAndRead = () => {
      const snapshot = fx.getSnapshot();
      const rows = snapshot.visibleRows({
        expanded: expandedRef.current,
        offset: 0,
        limit: 100_000,
        includeIgnored: true,
      });
      const directoriesToExpand: number[] = [];
      for (const root of snapshot.roots()) {
        if (!expandedRef.current.has(root.id)) directoriesToExpand.push(root.id);
      }
      for (const row of rows) {
        if (row.kind === 1 && !expandedRef.current.has(row.id)) directoriesToExpand.push(row.id);
      }
      if (directoriesToExpand.length > 0) {
        for (const id of directoriesToExpand) expandedRef.current.add(id);
        queueMicrotask(() => treeRef.current?.expand(directoriesToExpand));
      }
      const firstPendingIndex = rows.findIndex((row) => row.pending === true);
      let hydrationPending = 0;
      if (firstPendingIndex >= 0) {
        const hydrationKey = `${snapshot.treeVersion}:${firstPendingIndex}`;
        hydrationPending = 1;
        if (hydrationWindowRef.current !== hydrationKey) {
          hydrationWindowRef.current = hydrationKey;
          queueMicrotask(() => {
            fx.setViewport({ offset: firstPendingIndex, limit: 200, overscan: 0 });
          });
        }
      } else {
        hydrationWindowRef.current = null;
      }
      return {
        snapshot,
        rows,
        outstandingExpansions: directoriesToExpand.length + hydrationPending,
      };
    };

    const evaluate = (): void => {
      if (!aliveRef.current || configRef.current === null) return;
      const { snapshot, rows, outstandingExpansions } = expandAndRead();
      const byName = new Map(rows.filter((row) => !row.pending).map((row) => [row.name, row]));

      if (
        !readySentRef.current &&
        !readyScheduledRef.current &&
        snapshot.roots().length > 0 &&
        isReferenceTreeReady(rows, configRef.current.seedFiles, outstandingExpansions)
      ) {
        // Start only after the complete seeded projection is visible and the
        // corresponding FileTree state has crossed two frame boundaries.
        // A fixed delay made cold hosts intermittently start with a partial
        // expansion, producing false misses and unrepresentative render spikes.
        readyScheduledRef.current = true;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!aliveRef.current || readySentRef.current) return;
            readySentRef.current = true;
            window.millePlayground.watchBenchReady();
          });
        });
      }

      for (const [id, pending] of pendingRef.current) {
        if (reportingRef.current.has(id)) continue;
        const matchesPresent = pending.operation.expectation.present.every((expected) => {
          const entry = byName.get(expected.name);
          if (!entry) return false;
          if (expected.kind !== undefined && entry.kind !== expected.kind) return false;
          if (expected.size !== undefined && entry.size !== expected.size) return false;
          return true;
        });
        const matchesAbsent = pending.operation.expectation.absent.every(
          (name) => !byName.has(name),
        );
        if (!matchesPresent || !matchesAbsent) continue;

        reportingRef.current.add(id);
        const mirrorAt = epochNow();
        const awaiting = {
          pending,
          mirrorAt,
          mirrorTreeVersion: snapshot.treeVersion,
        };
        awaitingCommitRef.current.set(id, awaiting);
        const latestCommit = latestTreeCommit();
        if (isCommitEligible(latestCommit, pending.completedAt, awaiting.mirrorTreeVersion)) {
          observeAfterCommit(id, awaiting, latestCommit);
        }
      }
    };

    window.millePlayground.onWatchBenchEvent((event: WatchBenchEvent) => {
      if (!aliveRef.current) return;
      switch (event.type) {
        case 'issued':
          pendingRef.current.set(event.operation.id, {
            operation: event.operation,
            completedAt: event.completedAt,
            warmup: event.warmup === true,
          });
          setCurrent(event.operation);
          evaluate();
          return;
        case 'timeout':
          console.error('[watch-bench] convergence timeout', {
            id: event.operation.id,
            kind: event.operation.kind,
            stage: awaitingCommitRef.current.has(event.operation.id)
              ? 'react-commit'
              : pendingRef.current.has(event.operation.id)
                ? 'mirror'
                : 'unknown',
            treeVersion: fx.getSnapshot().treeVersion,
            latestCommitAt: latestTreeCommit()?.commitAt ?? null,
          });
          pendingRef.current.delete(event.operation.id);
          awaitingCommitRef.current.delete(event.operation.id);
          reportingRef.current.delete(event.operation.id);
          setFailed((value) => value + 1);
          return;
        case 'complete':
          setComplete(event.summary);
          setCurrent(null);
          return;
        case 'fatal':
          setFatal(event.message);
          setCurrent(null);
      }
    });

    const subscription = fx.on('change', evaluate);
    void window.millePlayground.getWatchBenchConfig().then((value) => {
      if (!aliveRef.current || value === null) return;
      configRef.current = value;
      setConfig(value);
      evaluate();
    });

    return () => {
      aliveRef.current = false;
      unsubscribeCommits();
      subscription.dispose();
    };
  }, [fx, treeRef]);

  const liveSummary = useMemo(() => {
    return {
      mirror: summarize(samples.map((sample) => sample.mirrorLatencyMs)),
      commit: summarize(samples.map((sample) => sample.commitLatencyMs)),
      reactDuration: summarize(samples.map((sample) => sample.reactDurationMs)),
      paint: summarize(samples.map((sample) => sample.paintLatencyMs)),
      commitToPaint: summarize(samples.map((sample) => sample.commitToPaintMs)),
      frameInterval: summarize(samples.map((sample) => sample.frameIntervalMs)),
    };
  }, [samples]);

  if (config === null) return null;
  const summary = complete ?? {
    count: samples.length,
    failed,
    durationMs: 0,
    operationsPerSecond: 0,
    ...liveSummary,
    qualityGate: { passed: true, violations: [] },
  };
  const finished = samples.length + failed;
  const progress = Math.min(100, (finished / config.operations) * 100);
  const recent = samples.slice(-48);
  const chartMax = Math.max(1, ...recent.map((sample) => sample.paintLatencyMs));

  return (
    <section className="watch-bench" aria-label="Watcher benchmark">
      <div className="watch-bench__header">
        <span className={`watch-bench__pulse${complete ? ' is-complete' : ''}`} />
        <strong>{complete ? 'Watch benchmark complete' : 'Watch benchmark running'}</strong>
        <span>
          {finished}/{config.operations}
        </span>
      </div>
      <div className="watch-bench__progress" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="watch-bench__metrics">
        <div>
          <span>mirror p50</span>
          <strong>{formatMs(summary.mirror.p50)}</strong>
        </div>
        <div>
          <span>commit p50</span>
          <strong>{formatMs(summary.commit.p50)}</strong>
        </div>
        <div>
          <span>React p95</span>
          <strong>{formatMs(summary.reactDuration.p95)}</strong>
        </div>
        <div>
          <span>paint p50</span>
          <strong>{formatMs(summary.paint.p50)}</strong>
        </div>
        <div>
          <span>paint p95</span>
          <strong>{formatMs(summary.paint.p95)}</strong>
        </div>
        <div>
          <span>max</span>
          <strong>{formatMs(summary.paint.max)}</strong>
        </div>
      </div>
      <div className="watch-bench__chart" aria-label="Recent paint latency samples">
        {recent.map((sample) => (
          <i
            key={sample.id}
            title={`#${sample.id} ${sample.kind}: ${formatMs(sample.paintLatencyMs)}`}
            style={{ height: `${Math.max(4, (sample.paintLatencyMs / chartMax) * 100)}%` }}
          />
        ))}
      </div>
      <div className="watch-bench__operation">
        {fatal ? (
          <span className="is-error">{fatal}</span>
        ) : complete ? (
          <span className={summary.qualityGate.passed ? undefined : 'is-error'}>
            {summary.qualityGate.passed
              ? `${summary.operationsPerSecond.toFixed(1)} ops/s · ${summary.failed} missed · gate passed · report saved`
              : `gate failed · ${summary.qualityGate.violations.join(' · ')}`}
          </span>
        ) : (
          <span>{current ? `#${current.id} ${current.label}` : 'Preparing expanded tree…'}</span>
        )}
      </div>
      <div className="watch-bench__config">
        {config.seedFiles} reference files · debounce {config.debounceMs} ms · timeout{' '}
        {config.timeoutMs} ms
      </div>
    </section>
  );
}
