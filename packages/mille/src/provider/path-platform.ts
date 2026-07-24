// Phase 6.2 — platform path helpers (pure, no native FS).
//
// Used by hosts and tests to reason about Windows drives/UNC, macOS
// Unicode normalization, and case-sensitivity policies without assuming
// the local OS.

export type PathPlatform = 'posix' | 'win32';

export interface ParsedPlatformPath {
  readonly platform: PathPlatform;
  /** Absolute form when recognized; otherwise null. */
  readonly absolute: boolean;
  /** Drive letter `C` for `C:\...`, else null. */
  readonly drive: string | null;
  /** UNC server for `\\server\share\...`, else null. */
  readonly uncServer: string | null;
  /** UNC share for `\\server\share\...`, else null. */
  readonly uncShare: string | null;
  /**
   * Normalized POSIX-style path for provider use:
   * - `C:\foo\bar` → `/C:/foo/bar`
   * - `\\server\share\a` → `//server/share/a`
   * - `/home/x` → `/home/x`
   */
  readonly posixPath: string;
  readonly segments: readonly string[];
}

/**
 * Detect whether a path is a Windows UNC path (`\\server\share\...` or
 * `//server/share/...`).
 */
export function isUncPath(path: string): boolean {
  return /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(path);
}

/** Detect Windows drive path: `C:\...` or `C:/...`. */
export function isWindowsDrivePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path);
}

/**
 * Parse a host path into a platform-neutral form for provider URIs.
 */
export function parsePlatformPath(
  path: string,
  platform: PathPlatform = guessPlatform(path),
): ParsedPlatformPath {
  // Honor an explicit platform. The default already guesses win32 for UNC and
  // drive forms, so re-checking them here would override a caller who passes
  // 'posix' deliberately — POSIX permits `\` and `:` in file names.
  return platform === 'win32' ? parseWin32(path) : parsePosix(path);
}

function guessPlatform(path: string): PathPlatform {
  if (isUncPath(path) || isWindowsDrivePath(path) || path.includes('\\')) {
    return 'win32';
  }
  return 'posix';
}

function parsePosix(path: string): ParsedPlatformPath {
  const normalized = path.replace(/\/+/g, '/') || '/';
  const absolute = normalized.startsWith('/');
  const segments = normalized.split('/').filter((s) => s.length > 0 && s !== '.');
  // Drop `..` for parse-only (does not resolve against FS).
  const stack: string[] = [];
  for (const s of segments) {
    if (s === '..') stack.pop();
    else stack.push(s);
  }
  const posixPath = absolute ? `/${stack.join('/')}` : stack.join('/');
  return {
    platform: 'posix',
    absolute,
    drive: null,
    uncServer: null,
    uncShare: null,
    posixPath: absolute ? (posixPath === '/' ? '/' : posixPath.replace(/\/$/, '') || '/') : posixPath,
    segments: stack,
  };
}

function parseWin32(path: string): ParsedPlatformPath {
  let p = path.replace(/\//g, '\\');
  if (isUncPath(p)) {
    // \\server\share\rest
    const trimmed = p.replace(/^[\\/]+/, '');
    const parts = trimmed.split(/\\+/).filter(Boolean);
    const server = parts[0] ?? '';
    const share = parts[1] ?? '';
    const rest = parts.slice(2);
    const posixPath = `//${server}/${share}${rest.length ? `/${rest.join('/')}` : ''}`;
    return {
      platform: 'win32',
      absolute: true,
      drive: null,
      uncServer: server,
      uncShare: share,
      posixPath,
      segments: [server, share, ...rest],
    };
  }
  if (isWindowsDrivePath(p)) {
    const drive = p[0]!.toUpperCase();
    const rest = p.slice(2).replace(/^[\\/]+/, '');
    const segments = rest.split(/\\+/).filter(Boolean);
    const posixPath = `/${drive}:/${segments.join('/')}`;
    return {
      platform: 'win32',
      absolute: true,
      drive,
      uncServer: null,
      uncShare: null,
      posixPath: segments.length === 0 ? `/${drive}:` : posixPath.replace(/\/$/, ''),
      segments: [`${drive}:`, ...segments],
    };
  }
  // Relative win path
  const segments = p.split(/\\+/).filter((s) => s.length > 0 && s !== '.');
  return {
    platform: 'win32',
    absolute: false,
    drive: null,
    uncServer: null,
    uncShare: null,
    posixPath: segments.join('/'),
    segments,
  };
}

/**
 * Compare two path strings under a case-sensitivity policy.
 * Applies Unicode NFC normalization first (macOS-friendly).
 */
export function pathsEqual(
  a: string,
  b: string,
  options: { caseSensitive?: boolean; unicodeForm?: 'NFC' | 'NFD' | 'none' } = {},
): boolean {
  const form = options.unicodeForm ?? 'NFC';
  const norm = (s: string): string => {
    const n = form === 'none' ? s : s.normalize(form);
    return n.replace(/\\/g, '/');
  };
  const left = norm(a);
  const right = norm(b);
  if (options.caseSensitive === false) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/**
 * Normalize a file name for comparison on macOS-like volumes (NFC).
 */
export function normalizeFileName(
  name: string,
  form: 'NFC' | 'NFD' = 'NFC',
): string {
  return name.normalize(form);
}

/**
 * Default case-sensitivity for a platform (policy hint for providers).
 * - posix (Linux): case-sensitive
 * - win32: case-insensitive
 * - darwin is not a PathPlatform here; hosts should pass caseSensitive:false
 *   for APFS default and true for case-sensitive volumes.
 */
export function defaultCaseSensitive(platform: PathPlatform): boolean {
  return platform === 'posix';
}

/**
 * Whether a relative segment list escapes a root (`..` at stack empty).
 */
export function segmentsEscapeRoot(segments: readonly string[]): boolean {
  let depth = 0;
  for (const s of segments) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      depth -= 1;
      if (depth < 0) return true;
    } else {
      depth += 1;
    }
  }
  return false;
}
