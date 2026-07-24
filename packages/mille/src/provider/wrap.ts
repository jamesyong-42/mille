// Provider wrappers — capability gate, latency, offline simulation.
//
// Optional methods are only exposed when the underlying provider implements
// them **and** capability bits allow the operation. Callers never see a
// fabricated method that throws TypeError.

import { FileSystemError } from '../errors.js';
import {
  providerSupportsOperation,
  requireCapability,
} from './capabilities.js';
import type { FileSystemProvider, ProviderOperation } from './types.js';

export interface LatencyOptions {
  /** Fixed delay in ms applied before every operation. Default 0. */
  readonly delayMs?: number;
  /** Extra random jitter 0..jitterMs. Default 0. */
  readonly jitterMs?: number;
  /** Optional AbortSignal checked after the delay. */
  readonly signal?: AbortSignal;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) {
      throw new FileSystemError('ECANCELED', 'operation aborted');
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new FileSystemError('ECANCELED', 'operation aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        reject(new FileSystemError('ECANCELED', 'operation aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Wrap a provider so mutating / optional operations are pre-checked against
 * capabilities **and** method presence. Missing methods throw EUNSUPPORTED
 * (never TypeError). Methods that the inner provider does not implement are
 * omitted from the wrapper surface.
 */
export function withCapabilityGate(
  provider: FileSystemProvider,
): FileSystemProvider {
  const gate = (op: ProviderOperation): void => {
    requireCapability(provider, op);
  };

  const out: FileSystemProvider = {
    scheme: provider.scheme,
    capabilities: provider.capabilities,
    async stat(uri) {
      return provider.stat(uri);
    },
    async readDirectory(uri) {
      return provider.readDirectory(uri);
    },
    async readFile(uri) {
      return provider.readFile(uri);
    },
  };

  if (typeof provider.writeFile === 'function') {
    out.writeFile = async (uri, data, options) => {
      gate('writeFile');
      if (options?.atomic) gate('atomicWrite');
      return provider.writeFile!(uri, data, options);
    };
  }

  if (typeof provider.createDirectory === 'function') {
    out.createDirectory = async (uri) => {
      gate('createDirectory');
      return provider.createDirectory!(uri);
    };
  }

  if (typeof provider.delete === 'function') {
    out.delete = async (uri, options) => {
      gate('delete');
      if (options?.trash) gate('trash');
      return provider.delete!(uri, options);
    };
  }

  if (typeof provider.rename === 'function') {
    out.rename = async (oldUri, newUri) => {
      gate('rename');
      return provider.rename!(oldUri, newUri);
    };
  }

  if (typeof provider.copy === 'function') {
    out.copy = async (source, destination) => {
      gate('copy');
      return provider.copy!(source, destination);
    };
  }

  if (typeof provider.watch === 'function') {
    out.watch = (uri, options) => {
      gate('watch');
      return provider.watch!(uri, options);
    };
  }

  if (typeof provider.readFileStream === 'function') {
    out.readFileStream = (uri, signal) => {
      gate('stream');
      return provider.readFileStream!(uri, signal);
    };
  }

  return out;
}

/**
 * Add artificial latency to methods the inner provider actually implements.
 * Does not fabricate missing optional methods.
 */
export function withLatency(
  provider: FileSystemProvider,
  options: LatencyOptions = {},
): FileSystemProvider {
  const delayMs = options.delayMs ?? 0;
  const jitterMs = options.jitterMs ?? 0;

  async function before(signal?: AbortSignal): Promise<void> {
    const jitter =
      jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
    await sleep(delayMs + jitter, signal ?? options.signal);
  }

  const out: FileSystemProvider = {
    scheme: provider.scheme,
    capabilities: provider.capabilities,
    async stat(uri) {
      await before();
      return provider.stat(uri);
    },
    async readDirectory(uri) {
      await before();
      return provider.readDirectory(uri);
    },
    async readFile(uri) {
      await before();
      return provider.readFile(uri);
    },
  };

  if (typeof provider.writeFile === 'function') {
    out.writeFile = async (uri, data, opts) => {
      await before();
      return provider.writeFile!(uri, data, opts);
    };
  }
  if (typeof provider.createDirectory === 'function') {
    out.createDirectory = async (uri) => {
      await before();
      return provider.createDirectory!(uri);
    };
  }
  if (typeof provider.delete === 'function') {
    out.delete = async (uri, opts) => {
      await before();
      return provider.delete!(uri, opts);
    };
  }
  if (typeof provider.rename === 'function') {
    out.rename = async (oldUri, newUri) => {
      await before();
      return provider.rename!(oldUri, newUri);
    };
  }
  if (typeof provider.copy === 'function') {
    out.copy = async (source, destination) => {
      await before();
      return provider.copy!(source, destination);
    };
  }
  if (typeof provider.watch === 'function') {
    out.watch = (uri, opts) => provider.watch!(uri, opts);
  }
  if (typeof provider.readFileStream === 'function') {
    out.readFileStream = (uri, signal) =>
      provider.readFileStream!(uri, signal);
  }

  return out;
}

export interface OfflineController {
  /** When true, all operations reject with a reconnect-style error. */
  setOffline(offline: boolean): void;
  isOffline(): boolean;
}

/**
 * Wrap a provider with a reconnect/offline switch. Only forwards methods
 * the inner provider implements.
 */
export function withOfflineGate(
  provider: FileSystemProvider,
): { provider: FileSystemProvider; offline: OfflineController } {
  let offline = false;

  function check(): void {
    if (offline) {
      throw new FileSystemError(
        'EBUSY',
        `Provider "${provider.scheme}" is offline`,
      );
    }
  }

  const wrapped: FileSystemProvider = {
    scheme: provider.scheme,
    capabilities: provider.capabilities,
    async stat(uri) {
      check();
      return provider.stat(uri);
    },
    async readDirectory(uri) {
      check();
      return provider.readDirectory(uri);
    },
    async readFile(uri) {
      check();
      return provider.readFile(uri);
    },
  };

  if (typeof provider.writeFile === 'function') {
    wrapped.writeFile = async (uri, data, opts) => {
      check();
      return provider.writeFile!(uri, data, opts);
    };
  }
  if (typeof provider.createDirectory === 'function') {
    wrapped.createDirectory = async (uri) => {
      check();
      return provider.createDirectory!(uri);
    };
  }
  if (typeof provider.delete === 'function') {
    wrapped.delete = async (uri, opts) => {
      check();
      return provider.delete!(uri, opts);
    };
  }
  if (typeof provider.rename === 'function') {
    wrapped.rename = async (oldUri, newUri) => {
      check();
      return provider.rename!(oldUri, newUri);
    };
  }
  if (typeof provider.copy === 'function') {
    wrapped.copy = async (source, destination) => {
      check();
      return provider.copy!(source, destination);
    };
  }
  if (typeof provider.watch === 'function') {
    wrapped.watch = (uri, opts) => {
      check();
      return provider.watch!(uri, opts);
    };
  }
  if (typeof provider.readFileStream === 'function') {
    wrapped.readFileStream = (uri, signal) => {
      check();
      return provider.readFileStream!(uri, signal);
    };
  }

  return {
    provider: wrapped,
    offline: {
      setOffline(v) {
        offline = v;
      },
      isOffline() {
        return offline;
      },
    },
  };
}

/** Convenience: gate + optional latency. */
export function hardenProvider(
  provider: FileSystemProvider,
  options: LatencyOptions = {},
): FileSystemProvider {
  let p = withCapabilityGate(provider);
  if ((options.delayMs ?? 0) > 0 || (options.jitterMs ?? 0) > 0) {
    p = withLatency(p, options);
  }
  return p;
}

/** Re-export for hosts that only import wrap. */
export { providerSupportsOperation };
