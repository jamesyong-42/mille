// Phase 5.3 — in-memory history + SCM clients for tests and demos.

import type {
  FileHistoryClient,
  FileHistoryQuery,
  FileHistoryRevision,
  ScmClient,
  ScmCompareRequest,
  ScmCompareResult,
} from './types.js';

export interface MapFileHistoryClient extends FileHistoryClient {
  setHistory(path: string, revisions: readonly FileHistoryRevision[]): void;
  setContents(path: string, revision: string, contents: string): void;
  clear(): void;
}

export function createMapFileHistoryClient(
  initial?: ReadonlyMap<string, readonly FileHistoryRevision[]>,
): MapFileHistoryClient {
  const history = new Map<string, FileHistoryRevision[]>();
  const contents = new Map<string, string>();

  if (initial) {
    for (const [p, revs] of initial) history.set(p, [...revs]);
  }

  function contentKey(path: string, revision: string): string {
    return `${path}@${revision}`;
  }

  return {
    async getHistory(query: FileHistoryQuery) {
      const list = history.get(query.path) ?? [];
      const limit = query.limit ?? list.length;
      return list.slice(0, limit);
    },
    async getContents(query) {
      return contents.get(contentKey(query.path, query.revision)) ?? null;
    },
    setHistory(path, revisions) {
      history.set(path, [...revisions]);
    },
    setContents(path, revision, text) {
      contents.set(contentKey(path, revision), text);
    },
    clear() {
      history.clear();
      contents.clear();
    },
  };
}

export interface MapScmClient extends ScmClient {
  readonly reverted: string[][];
  readonly staged: string[][];
  readonly unstaged: string[][];
  readonly compares: ScmCompareRequest[];
  workingContents: Map<string, string>;
  revisionContents: Map<string, string>;
}

export function createMapScmClient(
  history?: MapFileHistoryClient,
): MapScmClient {
  const reverted: string[][] = [];
  const staged: string[][] = [];
  const unstaged: string[][] = [];
  const compares: ScmCompareRequest[] = [];
  const workingContents = new Map<string, string>();
  const revisionContents = new Map<string, string>();

  function label(side: ScmCompareRequest['left']): string {
    return side.kind === 'working' ? 'Working Tree' : side.revision;
  }

  async function sideContents(
    path: string,
    side: ScmCompareRequest['left'],
  ): Promise<string | null> {
    if (side.kind === 'working') {
      return workingContents.get(path) ?? null;
    }
    const key = `${path}@${side.revision}`;
    if (revisionContents.has(key)) return revisionContents.get(key) ?? null;
    if (history?.getContents) {
      const c = await history.getContents({ path, revision: side.revision });
      return typeof c === 'string' ? c : c === null ? null : new TextDecoder().decode(c);
    }
    return null;
  }

  return {
    reverted,
    staged,
    unstaged,
    compares,
    workingContents,
    revisionContents,
    async revert(paths) {
      reverted.push([...paths]);
      for (const p of paths) workingContents.delete(p);
    },
    async stage(paths) {
      staged.push([...paths]);
    },
    async unstage(paths) {
      unstaged.push([...paths]);
    },
    async compare(request): Promise<ScmCompareResult> {
      compares.push(request);
      return {
        path: request.path,
        leftLabel: label(request.left),
        rightLabel: label(request.right),
        left: await sideContents(request.path, request.left),
        right: await sideContents(request.path, request.right),
      };
    },
  };
}
