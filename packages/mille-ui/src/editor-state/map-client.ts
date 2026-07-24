// Phase 5.1 — mutable in-memory EditorStateClient for demos and tests.

import type {
  EditorStateClient,
  EditorStateSnapshot,
  EditorTabState,
} from './types.js';

export interface MapEditorStateClient extends EditorStateClient {
  setState(snapshot: EditorStateSnapshot): void;
  setTabs(tabs: readonly EditorTabState[], activePath?: string | null): void;
  open(path: string, options?: { dirty?: boolean; active?: boolean }): void;
  close(path: string): void;
  setDirty(path: string, dirty: boolean): void;
  setActive(path: string | null): void;
  clear(): void;
  readonly size: number;
}

export interface CreateMapEditorStateClientOptions {
  readonly initial?: EditorStateSnapshot;
}

export function createMapEditorStateClient(
  options: CreateMapEditorStateClientOptions = {},
): MapEditorStateClient {
  let snapshot: EditorStateSnapshot = options.initial
    ? cloneSnapshot(options.initial)
    : { open: [] };
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const l of [...listeners]) l();
  }

  return {
    getEditorState(_root: string) {
      return cloneSnapshot(snapshot);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    setState(next) {
      snapshot = cloneSnapshot(next);
      notify();
    },
    setTabs(tabs, activePath) {
      const next: EditorStateSnapshot = {
        open: tabs.map((t) => ({ ...t })),
      };
      if (activePath !== undefined) {
        (next as { activePath: string | null }).activePath = activePath;
      }
      snapshot = next;
      notify();
    },
    open(path, options = {}) {
      const tabs = snapshot.open.filter((t) => t.path !== path);
      const active = options.active === true;
      const nextTabs = [
        ...tabs.map((t) =>
          active ? { ...t, active: false } : t,
        ),
        {
          path,
          dirty: options.dirty === true,
          ...(active ? { active: true } : {}),
        },
      ];
      const next: EditorStateSnapshot = { open: nextTabs };
      if (active) {
        (next as { activePath: string }).activePath = path;
      } else if (snapshot.activePath !== undefined) {
        (next as { activePath: string | null }).activePath =
          snapshot.activePath;
      }
      snapshot = next;
      notify();
    },
    close(path) {
      const nextOpen = snapshot.open.filter((t) => t.path !== path);
      if (nextOpen.length === snapshot.open.length) return;
      const next: EditorStateSnapshot = { open: nextOpen };
      if (snapshot.activePath === path) {
        (next as { activePath: null }).activePath = null;
      } else if (snapshot.activePath !== undefined) {
        (next as { activePath: string | null }).activePath =
          snapshot.activePath;
      }
      snapshot = next;
      notify();
    },
    setDirty(path, dirty) {
      let found = false;
      const nextOpen = snapshot.open.map((t) => {
        if (t.path !== path) return t;
        found = true;
        return { ...t, dirty };
      });
      if (!found) {
        nextOpen.push({ path, dirty });
      }
      snapshot = { ...snapshot, open: nextOpen };
      notify();
    },
    setActive(path) {
      snapshot = {
        open: snapshot.open.map((t) => ({
          ...t,
          active: path !== null && t.path === path,
        })),
        activePath: path,
      };
      notify();
    },
    clear() {
      if (snapshot.open.length === 0 && snapshot.activePath == null) return;
      snapshot = { open: [], activePath: null };
      notify();
    },
    get size() {
      return snapshot.open.length;
    },
  };
}

function cloneSnapshot(s: EditorStateSnapshot): EditorStateSnapshot {
  return {
    open: s.open.map((t) => ({ ...t })),
    ...(s.activePath !== undefined ? { activePath: s.activePath } : {}),
  };
}
