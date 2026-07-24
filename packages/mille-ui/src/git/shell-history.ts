// Phase 5.3 — shell-backed FileHistoryClient + ScmClient (Node only).
//
// Uses `git log` / `git show` / `git checkout --` / `git restore`.
// Never throws to the host for missing git — returns empty history or
// rejects with a clear Error for mutations.
//
// Security: every relative path is validated with `isSafeWorkspaceRelativePath`
// and resolved under the client root before any filesystem or git path use.

import { spawn as nodeSpawn } from 'node:child_process';
import * as path from 'node:path';

import { isSafeWorkspaceRelativePath } from '../diagnostics/provider.js';
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

/**
 * Resolve `relativePath` under `rootPath` and assert it cannot escape the root.
 * Returns the normalized workspace-relative POSIX path (no leading slash).
 */
export function assertPathUnderRoot(
  rootPath: string,
  relativePath: string,
): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('path must be a non-empty workspace-relative path');
  }
  // Reject absolute / home / drive forms before any slash-stripping so
  // `/etc/passwd` cannot be re-interpreted as a relative `etc/passwd`.
  if (
    relativePath.startsWith('/') ||
    relativePath.startsWith('~') ||
    /^[a-zA-Z]:/.test(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.includes('\0')
  ) {
    throw new Error(`path escapes workspace root: ${relativePath}`);
  }
  const rel = relativePath.replace(/^\/+/, '');
  if (rel.length === 0) {
    throw new Error('path must be a non-empty workspace-relative path');
  }
  if (!isSafeWorkspaceRelativePath(rel)) {
    throw new Error(`path escapes workspace root: ${relativePath}`);
  }
  const rootResolved = path.resolve(rootPath);
  const absolute = path.resolve(rootResolved, ...rel.split('/'));
  const contained = path.relative(rootResolved, absolute);
  if (
    contained === '' ||
    contained === '..' ||
    contained.startsWith(`..${path.sep}`) ||
    path.isAbsolute(contained)
  ) {
    throw new Error(`path escapes workspace root: ${relativePath}`);
  }
  return rel;
}

/**
 * Validate a git revision before it is interpolated into `git show <rev>:<path>`.
 *
 * That argument is positional, so a revision beginning with `-` reaches git as
 * an **option** rather than a revision — `--output=<file>` alone is an
 * arbitrary-file-write primitive. Rejecting `:` is not enough, because the
 * colon comes from the template rather than the revision.
 *
 * Accepts the characters real revisions use: `HEAD`, `HEAD~3`, `HEAD@{2}`,
 * `v1.2.0^{}`, `refs/heads/my-branch`, and hex object ids.
 */
export function assertSafeRevision(revision: string): string {
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new Error('revision must be a non-empty string');
  }
  if (revision.startsWith('-')) {
    throw new Error(`invalid revision (looks like a git option): ${revision}`);
  }
  // `:` would inject a second `rev:path` separator; the rest are shell/arg
  // metacharacters and control bytes that no legitimate revision contains.
  if (!/^[A-Za-z0-9._/^~@{}+-]+$/.test(revision)) {
    throw new Error(`invalid revision: ${revision}`);
  }
  return revision;
}

/** Coerce a caller-supplied limit into a safe positive integer. */
function safeLimit(limit: unknown, fallback: number): number {
  const n = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 10_000);
}

/**
 * Containment check for paths that have already been resolved on disk.
 * `assertPathUnderRoot` is lexical, so it cannot see a symlink inside the
 * workspace that resolves outside it; call this before following one.
 */
export function assertRealPathUnderRoot(
  realRoot: string,
  realTarget: string,
  reportedPath: string,
): void {
  const contained = path.relative(realRoot, realTarget);
  if (
    contained === '' ||
    contained === '..' ||
    contained.startsWith(`..${path.sep}`) ||
    path.isAbsolute(contained)
  ) {
    throw new Error(`path escapes workspace root: ${reportedPath}`);
  }
}

function assertPathsUnderRoot(
  rootPath: string,
  paths: readonly string[],
): string[] {
  return paths.map((p) => assertPathUnderRoot(rootPath, p));
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
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (signal?.aborted) {
    const err = new Error('git operation aborted');
    (err as Error & { code?: string }).code = 'ABORT_ERR';
    throw err;
  }
  const child = opts.spawn(opts.gitPath, args, { cwd: opts.rootPath });
  let abortListener: (() => void) | undefined;
  if (signal) {
    abortListener = () => {
      try {
        if (typeof child.kill === 'function') {
          child.kill('SIGTERM');
        }
      } catch {
        /* already dead */
      }
    };
    if (signal.aborted) {
      abortListener();
    } else {
      signal.addEventListener('abort', abortListener, { once: true });
    }
  }
  try {
    const result = await collectChild(child);
    if (signal?.aborted) {
      const err = new Error('git operation aborted');
      (err as Error & { code?: string }).code = 'ABORT_ERR';
      throw err;
    }
    return result;
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }
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
      const root = path.resolve(query.rootPath ?? rootPath);
      const rel = assertPathUnderRoot(root, query.path);
      const limit = safeLimit(query.limit, 50);
      const result = await runGit(
        { rootPath: root, gitPath, spawn },
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
      const root = path.resolve(query.rootPath ?? rootPath);
      const rel = assertPathUnderRoot(root, query.path);
      // `git show <rev>:<path>` cannot use a `--` separator: after `--` git
      // reads the argument as a pathspec and returns nothing. The revision
      // guard above is what keeps this positional argument safe.
      const rev = assertSafeRevision(query.revision);
      const result = await runGit({ rootPath: root, gitPath, spawn }, [
        'show',
        `${rev}:${rel}`,
      ]);
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
      const root = path.resolve(opts?.rootPath ?? defaultRoot);
      if (paths.length === 0) return;
      const safe = assertPathsUnderRoot(root, paths);
      // Prefer `git restore` (modern); fall back to checkout.
      let result = await runGit(
        { rootPath: root, gitPath, spawn },
        ['restore', '--worktree', '--', ...safe],
        opts?.signal,
      );
      if (result.code !== 0) {
        result = await runGit(
          { rootPath: root, gitPath, spawn },
          ['checkout', 'HEAD', '--', ...safe],
          opts?.signal,
        );
      }
      if (result.code !== 0) {
        const msg = result.stderr.trim() || 'git restore failed';
        warn(`mille-ui/scm: revert failed: ${msg}`);
        throw new Error(msg);
      }
    },
    async compare(request, options): Promise<ScmCompareResult> {
      const root = path.resolve(request.rootPath ?? defaultRoot);
      const rel = assertPathUnderRoot(root, request.path);

      async function load(
        side: ScmCompareRequest['left'],
      ): Promise<string | null> {
        if (side.kind === 'working') {
          const { readFileSync, realpathSync } = await import('node:fs');
          const absolute = path.resolve(root, ...rel.split('/'));
          // `rel` is lexically contained, but a symlink inside the workspace
          // can still point outside it, and reading follows the link. Resolve
          // both ends before reading.
          let realTarget: string;
          try {
            realTarget = realpathSync(absolute);
          } catch {
            return null; // missing / unreadable working copy is not an error
          }
          assertRealPathUnderRoot(realpathSync(root), realTarget, request.path);
          try {
            return readFileSync(realTarget, 'utf8');
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

      // Honor abort before / between side loads.
      if (options?.signal?.aborted) {
        const err = new Error('git operation aborted');
        (err as Error & { code?: string }).code = 'ABORT_ERR';
        throw err;
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
      const root = path.resolve(opts?.rootPath ?? defaultRoot);
      if (paths.length === 0) return;
      const safe = assertPathsUnderRoot(root, paths);
      const result = await runGit(
        { rootPath: root, gitPath, spawn },
        ['add', '--', ...safe],
        opts?.signal,
      );
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || 'git add failed');
      }
    },
    async unstage(paths, opts) {
      const root = path.resolve(opts?.rootPath ?? defaultRoot);
      if (paths.length === 0) return;
      const safe = assertPathsUnderRoot(root, paths);
      const result = await runGit(
        { rootPath: root, gitPath, spawn },
        ['restore', '--staged', '--', ...safe],
        opts?.signal,
      );
      if (result.code !== 0) {
        const fallback = await runGit(
          { rootPath: root, gitPath, spawn },
          ['reset', 'HEAD', '--', ...safe],
          opts?.signal,
        );
        if (fallback.code !== 0) {
          throw new Error(fallback.stderr.trim() || 'git unstage failed');
        }
      }
    },
  };
}
