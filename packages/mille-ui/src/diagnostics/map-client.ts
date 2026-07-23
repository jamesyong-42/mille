// Phase 5.1 — in-memory DiagnosticsClient for hosts, demos, and tests.
//
// Language servers push diagnostics into this client; the decoration
// companion polls via getDiagnostics / onChange. Not a language server
// itself — just the glue hosts need before they have a full LSP bridge.

import type { Diagnostic, DiagnosticsClient } from './types.js';

export interface MapDiagnosticsClient extends DiagnosticsClient {
  /**
   * Replace the full diagnostics snapshot. Paths are workspace-relative
   * POSIX paths (same convention as `Diagnostic.path`). Fires `onChange`.
   */
  setAll(map: ReadonlyMap<string, readonly Diagnostic[]>): void;
  /**
   * Replace diagnostics for a single path. Pass an empty array (or
   * omit) to clear that path. Fires `onChange`.
   */
  set(path: string, diagnostics: readonly Diagnostic[]): void;
  /** Drop every diagnostic. Fires `onChange`. */
  clear(): void;
  /** Current snapshot size (number of paths with diagnostics). */
  readonly size: number;
}

export interface CreateMapDiagnosticsClientOptions {
  /** Optional initial snapshot. */
  readonly initial?: ReadonlyMap<string, readonly Diagnostic[]>;
}

/**
 * Build a mutable, in-memory `DiagnosticsClient`. Suitable for:
 * - unit / integration tests
 * - playground demos
 * - hosts that already have diagnostics and only need the decoration bridge
 */
export function createMapDiagnosticsClient(
  options: CreateMapDiagnosticsClientOptions = {},
): MapDiagnosticsClient {
  let snapshot = cloneMap(options.initial ?? new Map());
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const l of [...listeners]) l();
  }

  return {
    async getDiagnostics(_root: string) {
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
    set(path, diagnostics) {
      const next = cloneMap(snapshot);
      if (diagnostics.length === 0) {
        next.delete(path);
      } else {
        next.set(path, [...diagnostics]);
      }
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

function cloneMap(
  map: ReadonlyMap<string, readonly Diagnostic[]>,
): Map<string, readonly Diagnostic[]> {
  const out = new Map<string, readonly Diagnostic[]>();
  for (const [k, v] of map) {
    if (v.length > 0) out.set(k, [...v]);
  }
  return out;
}
