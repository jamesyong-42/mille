// URI helpers for provider paths (POSIX within a scheme).

import type { Uri } from './types.js';

export function createUri(
  scheme: string,
  path: string,
  extras: { authority?: string; query?: string; fragment?: string } = {},
): Uri {
  const normalized = normalizeUriPath(path);
  const uri: Uri = { scheme, path: normalized };
  if (extras.authority !== undefined) {
    (uri as { authority?: string }).authority = extras.authority;
  }
  if (extras.query !== undefined) {
    (uri as { query?: string }).query = extras.query;
  }
  if (extras.fragment !== undefined) {
    (uri as { fragment?: string }).fragment = extras.fragment;
  }
  return uri;
}

/** Ensure leading slash, collapse `//`, strip trailing slash (except root). */
export function normalizeUriPath(path: string): string {
  let p = path.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export function joinUriPath(base: string, name: string): string {
  const b = normalizeUriPath(base);
  const n = name.replace(/^\/+/, '').replace(/\\/g, '/');
  if (n.includes('/') || n === '..' || n === '.') {
    throw new Error(`invalid path segment: ${name}`);
  }
  return b === '/' ? `/${n}` : `${b}/${n}`;
}

export function basenameUriPath(path: string): string {
  const p = normalizeUriPath(path);
  if (p === '/') return '';
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

export function dirnameUriPath(path: string): string {
  const p = normalizeUriPath(path);
  if (p === '/') return '/';
  const i = p.lastIndexOf('/');
  if (i <= 0) return '/';
  return p.slice(0, i);
}

export function uriEquals(a: Uri, b: Uri, caseSensitive = true): boolean {
  if (a.scheme !== b.scheme) return false;
  if ((a.authority ?? '') !== (b.authority ?? '')) return false;
  if (caseSensitive) return normalizeUriPath(a.path) === normalizeUriPath(b.path);
  return (
    normalizeUriPath(a.path).toLowerCase() ===
    normalizeUriPath(b.path).toLowerCase()
  );
}

export function formatUri(uri: Uri): string {
  const auth = uri.authority ? `//${uri.authority}` : '';
  const q = uri.query ? `?${uri.query}` : '';
  const f = uri.fragment ? `#${uri.fragment}` : '';
  return `${uri.scheme}:${auth}${normalizeUriPath(uri.path)}${q}${f}`;
}
