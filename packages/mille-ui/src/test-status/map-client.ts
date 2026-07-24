// Phase 5.1 — mutable in-memory TestStatusClient for demos and tests.

import type { TestResult, TestStatusClient } from './types.js';

export interface MapTestStatusClient extends TestStatusClient {
  setAll(map: ReadonlyMap<string, TestResult>): void;
  set(path: string, result: TestResult | null): void;
  clear(): void;
  readonly size: number;
}

export interface CreateMapTestStatusClientOptions {
  readonly initial?: ReadonlyMap<string, TestResult> | readonly TestResult[];
}

export function createMapTestStatusClient(
  options: CreateMapTestStatusClientOptions = {},
): MapTestStatusClient {
  let snapshot = toMap(options.initial);
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const l of [...listeners]) l();
  }

  return {
    getResults(_root: string) {
      return cloneMap(snapshot);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    setAll(map) {
      snapshot = cloneMap(map);
      notify();
    },
    set(path, result) {
      const next = cloneMap(snapshot);
      if (result === null) next.delete(path);
      else next.set(path, { ...result, path: result.path || path });
      snapshot = next;
      notify();
    },
    clear() {
      if (snapshot.size === 0) return;
      snapshot = new Map();
      notify();
    },
    get size() {
      return snapshot.size;
    },
  };
}

function toMap(
  initial: CreateMapTestStatusClientOptions['initial'],
): Map<string, TestResult> {
  const out = new Map<string, TestResult>();
  if (initial === undefined) return out;
  if (Array.isArray(initial)) {
    for (const r of initial) out.set(r.path, r);
    return out;
  }
  return cloneMap(initial as ReadonlyMap<string, TestResult>);
}

function cloneMap(
  map: ReadonlyMap<string, TestResult>,
): Map<string, TestResult> {
  const out = new Map<string, TestResult>();
  for (const [k, v] of map) out.set(k, { ...v });
  return out;
}
