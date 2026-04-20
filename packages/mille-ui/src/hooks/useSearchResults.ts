// useSearchResults — debounced call into `fx.search(query, { limit })`.
//
// Phase 8. Returns a structured state consumers can switch on:
//
//   { status: 'idle',    hits: [] }                        // query empty / disabled
//   { status: 'loading', hits: [] }                        // in flight
//   { status: 'ready',   hits: SearchHit[] }               // resolved
//   { status: 'error',   hits: [], error: Error }          // rejected
//
// - 150ms debounce before dispatch. Re-queries within the window cancel
//   the pending timer; in-flight requests are aborted via AbortController.
// - `enabled: false` short-circuits to `'idle'` and cancels any pending
//   work — used by the tree when it's in `'filter'` mode.
//
// The fake engine used in tests doesn't have to understand AbortSignal;
// it just needs to return a resolved `readonly SearchHit[]`. Real engine
// calls pass the signal through.

import { useEffect, useRef, useState } from 'react';
import type { SearchHit, SearchOptions } from '@vibecook/mille';

/** Minimum engine surface this hook uses. */
export interface SearchableEngine {
  search(query: string, options?: SearchOptions): Promise<readonly SearchHit[]>;
}

export interface UseSearchResultsOptions {
  readonly fx: SearchableEngine;
  readonly query: string;
  readonly limit?: number;
  readonly enabled?: boolean;
  /**
   * Testing hook — override the debounce delay in ms. Production
   * callers should leave this unset (defaults to 150 ms per SPEC §18
   * integration tests).
   */
  readonly debounceMs?: number;
}

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseSearchResultsResult {
  readonly status: SearchStatus;
  readonly hits: readonly SearchHit[];
  readonly error?: Error;
}

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_LIMIT = 100;

export function useSearchResults(
  options: UseSearchResultsOptions,
): UseSearchResultsResult {
  const {
    fx,
    query,
    limit = DEFAULT_LIMIT,
    enabled = true,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = options;

  const [state, setState] = useState<UseSearchResultsResult>({
    status: 'idle',
    hits: [],
  });

  // Latest abort controller and debounce timer; cleaned up on unmount
  // and on every re-query.
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation counter — each dispatch captures a generation; stale
  // resolutions (an older search resolving after a newer one fired)
  // compare against the latest and are dropped.
  const generationRef = useRef(0);

  useEffect(() => {
    // Cancel any pending timer / in-flight request on every pass.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    // Short-circuits that don't kick off a search.
    if (!enabled || query === '') {
      // Stay quiet — only push a new state if the previous one wasn't
      // already `'idle'`, to avoid a gratuitous render.
      setState((prev) =>
        prev.status === 'idle' && prev.hits.length === 0 ? prev : { status: 'idle', hits: [] },
      );
      return undefined;
    }

    // Enter loading immediately — the UI should reflect that a search
    // is pending even before the debounce fires. Tests can observe the
    // status transition.
    setState({ status: 'loading', hits: [] });

    const myGeneration = generationRef.current + 1;
    generationRef.current = myGeneration;

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const controller = new AbortController();
      abortRef.current = controller;

      // `SearchOptions` exposed from `@vibecook/mille`'s client surface
      // doesn't advertise a `signal` field (api.d.ts does). We thread
      // the signal via an augmented structural type so real implementations
      // that accept a signal get one, without tripping TS on the minimal
      // surface.
      const searchOpts = {
        limit,
        signal: controller.signal,
      } as unknown as SearchOptions;

      // Some fakes return a synchronous-looking Promise; wrap defensively.
      let p: Promise<readonly SearchHit[]>;
      try {
        p = Promise.resolve(fx.search(query, searchOpts));
      } catch (err) {
        if (myGeneration === generationRef.current) {
          setState({
            status: 'error',
            hits: [],
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
        return;
      }

      p.then(
        (hits) => {
          if (controller.signal.aborted) return;
          if (myGeneration !== generationRef.current) return;
          setState({ status: 'ready', hits });
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          if (myGeneration !== generationRef.current) return;
          setState({
            status: 'error',
            hits: [],
            error: err instanceof Error ? err : new Error(String(err)),
          });
        },
      );
    }, debounceMs);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (abortRef.current !== null) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [fx, query, limit, enabled, debounceMs]);

  return state;
}
