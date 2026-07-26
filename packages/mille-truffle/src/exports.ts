// Export definition, validation and host-cache keys (SPEC §15).
//
// An export is the unit a client asks for by name. The client never supplies
// a path — that is the whole point, and it is why traversal is not a class
// of bug this design has to defend against at request time (SEC-002,
// FR-005). Roots are resolved once, at startup, from server configuration.
//
// Validation is deliberately fail-fast: a misconfigured export should stop
// the service coming up, not surface as a confusing denial on someone's
// first connection.

import { createHash } from 'node:crypto';
import { realpathSync, statSync, accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';

import type { MilleExportConfig, ResolvedExport } from './types.js';

const EXPORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 16 MiB — the control stream is not a bulk transfer channel (SPEC §20.2). */
export const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_SESSIONS = 16;

export class ExportConfigError extends Error {
  override readonly name = 'ExportConfigError';
}

/**
 * Resolve and validate one export.
 *
 * Canonicalizing here rather than per-request is what makes the boundary
 * checkable at all: every later containment test compares against a path
 * that has already had symlinks, `..`, and case variations collapsed out of
 * it.
 */
export function resolveExport(id: string, config: MilleExportConfig): ResolvedExport {
  if (!EXPORT_ID_RE.test(id)) {
    throw new ExportConfigError(
      `export id ${JSON.stringify(id)} must match ${String(EXPORT_ID_RE)}`,
    );
  }
  if (typeof config.label !== 'string' || config.label.length === 0) {
    throw new ExportConfigError(`export ${id}: label is required`);
  }
  if (config.access !== 'read-only' && config.access !== 'read-write') {
    throw new ExportConfigError(`export ${id}: access must be read-only or read-write`);
  }
  // SEC-003. Phase 1 does not follow links on a remote export, and silently
  // accepting `true` would hand a client the rest of the filesystem.
  if (config.followSymlinks !== undefined && config.followSymlinks !== false) {
    throw new ExportConfigError(
      `export ${id}: followSymlinks must be false for a remote export (SPEC SEC-003)`,
    );
  }
  if (!Array.isArray(config.roots) || config.roots.length === 0) {
    throw new ExportConfigError(`export ${id}: at least one root is required`);
  }

  const canonical: string[] = [];
  for (const root of config.roots) {
    if (typeof root !== 'string' || root.length === 0) {
      throw new ExportConfigError(`export ${id}: roots must be non-empty strings`);
    }
    if (!isAbsolute(root)) {
      throw new ExportConfigError(`export ${id}: root ${JSON.stringify(root)} must be absolute`);
    }
    let resolved: string;
    try {
      resolved = realpathSync.native(root);
    } catch (err) {
      throw new ExportConfigError(
        `export ${id}: root ${JSON.stringify(root)} cannot be resolved: ${(err as Error).message}`,
      );
    }
    if (!statSync(resolved).isDirectory()) {
      throw new ExportConfigError(`export ${id}: root ${JSON.stringify(root)} is not a directory`);
    }
    // Compare case-insensitively on platforms where the filesystem is, so
    // two spellings of one directory cannot both be served.
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (canonical.some((c) => (process.platform === 'win32' ? c.toLowerCase() : c) === key)) {
      throw new ExportConfigError(
        `export ${id}: duplicate canonical root ${JSON.stringify(resolved)}`,
      );
    }
    canonical.push(resolved);
  }

  // A read-write export that cannot write is a lie the client would only
  // discover mid-operation. §15.1 forbids the silent downgrade, so fail.
  if (config.access === 'read-write') {
    for (const root of canonical) {
      try {
        accessSync(root, constants.W_OK);
      } catch {
        throw new ExportConfigError(
          `export ${id}: declared read-write but ${JSON.stringify(root)} is not writable`,
        );
      }
    }
  }

  const maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new ExportConfigError(`export ${id}: maxFileBytes must be a positive integer`);
  }
  const maxSessions = config.maxSessions ?? DEFAULT_MAX_SESSIONS;
  if (!Number.isInteger(maxSessions) || maxSessions <= 0) {
    throw new ExportConfigError(`export ${id}: maxSessions must be a positive integer`);
  }

  return {
    id,
    label: config.label,
    access: config.access,
    roots: canonical,
    explorer: config.explorer ?? {},
    ...(config.allowedPeerIds === undefined
      ? null
      : { allowedPeerIds: [...config.allowedPeerIds] }),
    maxFileBytes,
    maxSessions,
    fingerprint: fingerprintExport(id, canonical, config.explorer),
  };
}

export function resolveExports(
  configs: Readonly<Record<string, MilleExportConfig>>,
): Map<string, ResolvedExport> {
  const out = new Map<string, ResolvedExport>();
  for (const [id, config] of Object.entries(configs)) {
    out.set(id, resolveExport(id, config));
  }
  return out;
}

/**
 * Host-cache key material.
 *
 * Two sessions share a host only when they would get an identical engine —
 * same roots in the same order, same explorer options. Authorization is
 * explicitly *not* part of this: who you are decides whether you may attach,
 * never which engine you attach to (§15.2).
 */
export function fingerprintExport(
  id: string,
  canonicalRoots: readonly string[],
  explorer: unknown,
): string {
  const material = JSON.stringify({ id, roots: canonicalRoots, explorer: explorer ?? {} });
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** Overlap is legal but almost always a mistake; the caller logs a warning. */
export function findOverlappingRoots(exports: ReadonlyMap<string, ResolvedExport>): string[] {
  const seen = new Map<string, string>();
  const warnings: string[] = [];
  for (const [id, ex] of exports) {
    for (const root of ex.roots) {
      const key = process.platform === 'win32' ? root.toLowerCase() : root;
      const prior = seen.get(key);
      if (prior !== undefined && prior !== id) {
        warnings.push(`exports ${prior} and ${id} both serve ${root}`);
      } else {
        seen.set(key, id);
      }
    }
  }
  return warnings;
}
