import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export const NAVIGATION_STORE_VERSION = 1;
export const NAVIGATION_STORE_MAX_WORKSPACES = 32;
export const NAVIGATION_STORE_MAX_STATE_BYTES = 500_000;

function emptyStore() {
  return { version: NAVIGATION_STORE_VERSION, workspaces: [] };
}

function validState(value, maxBytes) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) return false;
  try {
    const parsed = JSON.parse(value);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      parsed.version === 1
    );
  } catch {
    return false;
  }
}

function normalizeStore(value, maxWorkspaces, maxStateBytes) {
  if (
    typeof value !== 'object' ||
    value === null ||
    value.version !== NAVIGATION_STORE_VERSION ||
    !Array.isArray(value.workspaces)
  ) {
    return emptyStore();
  }
  const byRoot = new Map();
  for (const candidate of value.workspaces) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof candidate.root !== 'string' ||
      candidate.root.length === 0 ||
      candidate.root.length > 32_768 ||
      typeof candidate.updatedAt !== 'number' ||
      !Number.isFinite(candidate.updatedAt) ||
      !validState(candidate.state, maxStateBytes)
    ) {
      continue;
    }
    const current = byRoot.get(candidate.root);
    if (!current || current.updatedAt < candidate.updatedAt) {
      byRoot.set(candidate.root, {
        root: candidate.root,
        updatedAt: candidate.updatedAt,
        state: candidate.state,
      });
    }
  }
  const workspaces = [...byRoot.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.root.localeCompare(b.root))
    .slice(0, maxWorkspaces);
  return { version: NAVIGATION_STORE_VERSION, workspaces };
}

export function createNavigationStateStore({
  filePath,
  maxWorkspaces = NAVIGATION_STORE_MAX_WORKSPACES,
  maxStateBytes = NAVIGATION_STORE_MAX_STATE_BYTES,
  now = Date.now,
}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('filePath must be a non-empty string');
  }
  let loaded = false;
  let store = emptyStore();

  const ensureLoaded = () => {
    if (loaded) return;
    loaded = true;
    try {
      store = normalizeStore(
        JSON.parse(readFileSync(filePath, 'utf8')),
        maxWorkspaces,
        maxStateBytes,
      );
    } catch {
      store = emptyStore();
    }
  };

  const persist = (next) => {
    const temporaryPath = `${filePath}.tmp-${process.pid}`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(next), 'utf8');
      renameSync(temporaryPath, filePath);
      return true;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    get(root) {
      ensureLoaded();
      if (typeof root !== 'string' || root.length === 0) return null;
      return store.workspaces.find((entry) => entry.root === root)?.state ?? null;
    },

    set(root, state) {
      ensureLoaded();
      if (
        typeof root !== 'string' ||
        root.length === 0 ||
        root.length > 32_768 ||
        !validState(state, maxStateBytes)
      ) {
        return false;
      }
      const existing = store.workspaces.find((entry) => entry.root === root);
      if (existing?.state === state) return true;
      const next = normalizeStore(
        {
          version: NAVIGATION_STORE_VERSION,
          workspaces: [
            { root, state, updatedAt: now() },
            ...store.workspaces.filter((entry) => entry.root !== root),
          ],
        },
        maxWorkspaces,
        maxStateBytes,
      );
      if (!persist(next)) return false;
      store = next;
      return true;
    },

    entries() {
      ensureLoaded();
      return store.workspaces.map((entry) => ({ ...entry }));
    },
  });
}
