// Workspace-root helpers shared by the main process, the fx utility, and
// tests. Pure except for `path.resolve`, so the trust check below can be
// tested without booting Electron.

import { resolve } from 'node:path';

/**
 * Read the workspace root list from the WORKSPACE_ROOTS env var.
 *
 * Falls back to the single primary root when the value is absent, malformed,
 * or empty — a bad env var should never stop the explorer from opening.
 *
 * @param {string | undefined} raw
 * @param {string} primary
 * @returns {string[]}
 */
export function parseWorkspaceRoots(raw, primary) {
  if (!raw) return [primary];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [primary];
    const roots = parsed.filter((r) => typeof r === 'string' && r.length > 0);
    return roots.length > 0 ? roots : [primary];
  } catch {
    return [primary];
  }
}

/**
 * Resolve a renderer-supplied `rootPath` against the open workspace roots.
 *
 * Multi-root SCM needs root B to be addressable, so the check is membership
 * in the open set rather than equality with one active root — but a renderer
 * still cannot name a directory outside the workspace. Throws on a
 * non-member; returns the *stored* spelling of the matched root so callers
 * pass a path the main process chose, not one the renderer sent.
 *
 * @param {unknown} requested
 * @param {readonly string[]} openRoots
 * @returns {string}
 */
export function resolveTrustedRoot(requested, openRoots) {
  if (openRoots.length === 0) {
    throw new Error('scm: no workspace root is open');
  }
  if (typeof requested !== 'string' || requested.length === 0) {
    return openRoots[0];
  }
  const wanted = resolve(requested);
  const match = openRoots.find((candidate) => resolve(candidate) === wanted);
  if (match === undefined) {
    throw new Error(
      'scm: rootPath is not an open workspace root (renderer roots are not trusted)',
    );
  }
  return match;
}
