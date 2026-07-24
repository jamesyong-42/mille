// Phase 5.3 — shell-backed FileHistoryClient + ScmClient (Node only).
//
// Uses `git log` / `git show` / `git checkout --` / `git restore`.
// Never throws to the host for missing git — returns empty history or
// rejects with a clear Error for mutations.

import { spawn as nodeSpawn } from 'node:child_process';
import * as path from 'node:path';

import type {
  FileHistoryClient,
  FileHistoryQuery,
  FileHistoryRevision,
  ScmClient,
  ScmCompareRequest,
  ScmCompareResult,
} from '../history/types.js';
import type { ChildProcessLike, SpawnLike } from './shell-client.js';

export interface ShellHistoryOptions {
  readonly rootPath: string;
  readonly gitPath?: string;
  readonly spawn?: SpawnLike;
  readonly warn?: (msg: string) => void;
}

function collectChild(
  child: ChildProcessLike,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    const settle = (code: number | null, errMsg: string | null): void => {
      if (settled) return;
      settled = true;
      resolve({
        code,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr:
          errMsg !== null
            ? errMsg
            : Buffer.concat(errChunks).toString('utf8'),
      });
    };
    child.stdout.on('data', (chunk: Buffer | string) => {
      outChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      errChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    child.on('error', (err) => settle(null, err.message));
    child.on('close', (code) => settle(code, null));
  });
}

async function runGit(
  opts: {
    rootPath: string;
    gitPath: string;
    spawn: SpawnLike;
  },
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = opts.spawn(opts.gitPath, args, { cwd: opts.rootPath });
  return collectChild(child);
}

/**
 * Parse `git log --format=%H%x09%h%x09%at%x09%an%x09%s -z` style records
 * joined with RS (we use custom format with newlines for simplicity).
 *
 * Format per line: `H<TAB>h<TAB>at<TAB>an<TAB>s`
 */
export function parseGitLogLines(stdout: string): FileHistoryRevision[] {
  const out: FileHistoryRevision[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const [id, shortId, at, author, ...msgParts] = parts;
    if (!id || !shortId) continue;
    const timestampMs = Number(at) * 1000;
    const message = msgParts.join('\t');
    const rev: FileHistoryRevision = {
      id,
      shortId,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
    };
    if (author !== undefined && author.length > 0) {
      (rev as { author?: string }).author = author;
    }
    if (message.length > 0) {
      (rev as { message?: string }).message = message;
    }
    out.push(rev);
  }
  return out;
}

export function createShellFileHistoryClient(
  options: ShellHistoryOptions,
): FileHistoryClient {
  const gitPath = options.gitPath ?? 'git';
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const rootPath = path.resolve(options.rootPath);

  return {
    async getHistory(query: FileHistoryQuery) {
      const rel = query.path.replace(/^\/+/, '');
      const limit = query.limit ?? 50;
      const result = await runGit(
        { rootPath: query.rootPath ?? rootPath, gitPath, spawn },
        [
          'log',
          `--max-count=${limit}`,
          '--format=%H\t%h\t%at\t%an\t%s',
          '--',
          rel,
        ],
      );
      if (result.code !== 0) {
        warn(
          `mille-ui/history: git log failed (${result.code}): ${result.stderr.trim()}`,
        );
        return [];
      }
      return parseGitLogLines(result.stdout);
    },
    async getContents(query) {
      const rel = query.path.replace(/^\/+/, '');
      const rev = query.revision;
      const result = await runGit(
        { rootPath: query.rootPath ?? rootPath, gitPath, spawn },
        ['show', `${rev}:${rel}`],
      );
      if (result.code !== 0) return null;
      return result.stdout;
    },
  };
}

export function createShellScmClient(options: ShellHistoryOptions): ScmClient {
  const gitPath = options.gitPath ?? 'git';
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const defaultRoot = path.resolve(options.rootPath);
  const history = createShellFileHistoryClient(options);

  function sideLabel(side: ScmCompareRequest['left']): string {
    return side.kind === 'working' ? 'Working Tree' : side.revision;
  }

  return {
    async revert(paths, opts) {
      const root = opts?.rootPath ?? defaultRoot;
      if (paths.length === 0) return;
      // Prefer `git restore` (modern); fall back to checkout.
      let result = await runGit(
        { rootPath: root, gitPath, spawn },
        ['restore', '--worktree', '--', ...paths],
      );
      if (result.code !== 0) {
        result = await runGit(
          { rootPath: root, gitPath, spawn },
          ['checkout', 'HEAD', '--', ...paths],
        );
      }
      if (result.code !== 0) {
        const msg = result.stderr.trim() || 'git restore failed';
        warn(`mille-ui/scm: revert failed: ${msg}`);
        throw new Error(msg);
      }
    },
    async compare(request): Promise<ScmCompareResult> {
      const root = request.rootPath ?? defaultRoot;
      const rel = request.path.replace(/^\/+/, '');

      async function load(
        side: ScmCompareRequest['left'],
      ): Promise<string | null> {
        if (side.kind === 'working') {
          // Read working tree via git show :path is index; use filesystem
          // through `git show HEAD:path` for revision only. Working = cat file.
          const { readFileSync } = await import('node:fs');
          try {
            return readFileSync(path.join(root, rel), 'utf8');
          } catch {
            return null;
          }
        }
        return history.getContents
          ? ((await history.getContents({
              path: rel,
              revision: side.revision,
              rootPath: root,
            })) as string | null)
          : null;
      }

      return {
        path: request.path,
        leftLabel: sideLabel(request.left),
        rightLabel: sideLabel(request.right),
        left: await load(request.left),
        right: await load(request.right),
      };
    },
    async stage(paths, opts) {
      const root = opts?.rootPath ?? defaultRoot;
      if (paths.length === 0) return;
      const result = await runGit(
        { rootPath: root, gitPath, spawn },
        ['add', '--', ...paths],
      );
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || 'git add failed');
      }
    },
    async unstage(paths, opts) {
      const root = opts?.rootPath ?? defaultRoot;
      if (paths.length === 0) return;
      const result = await runGit(
        { rootPath: root, gitPath, spawn },
        ['restore', '--staged', '--', ...paths],
      );
      if (result.code !== 0) {
        const fallback = await runGit(
          { rootPath: root, gitPath, spawn },
          ['reset', 'HEAD', '--', ...paths],
        );
        if (fallback.code !== 0) {
          throw new Error(fallback.stderr.trim() || 'git unstage failed');
        }
      }
    },
  };
}
