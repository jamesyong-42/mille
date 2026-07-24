// In-memory FileSystemProvider — non-local test / demo backend (Phase 6.1).

import { FileSystemError } from '../errors.js';
import { Capability, EntryKind, type FileSystemEvent, type FileSystemProvider, type ProviderEntry, type Uri, type Watcher } from './types.js';
import {
  basenameUriPath,
  createUri,
  dirnameUriPath,
  joinUriPath,
  normalizeUriPath,
} from './uri.js';

export interface MemoryFileSystemOptions {
  readonly scheme?: string;
  /**
   * Capability mask. Default: ReadWrite | CaseSensitive | Watch | Clone |
   * AtomicWrite. Pass `Capability.Readonly` for a read-only memfs.
   */
  readonly capabilities?: number;
  /** Seed tree: path (POSIX absolute) → file contents (string or bytes). */
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  /** Seed empty directories (POSIX absolute paths). */
  readonly directories?: readonly string[];
}

interface MemNode {
  id: number;
  parentId: number | null;
  name: string;
  kind: typeof EntryKind.File | typeof EntryKind.Directory;
  content: Uint8Array;
  mtimeMs: number;
  ctimeMs: number;
  /** child name → path key */
  children: Map<string, string>;
}

function encoder(): { encode(input?: string): Uint8Array } {
  return new TextEncoder();
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? encoder().encode(data) : data;
}

function pathKey(path: string, caseSensitive: boolean): string {
  const n = normalizeUriPath(path);
  return caseSensitive ? n : n.toLowerCase();
}

/**
 * Create an in-memory filesystem provider. Suitable for tests, demos, and
 * hosts that need a non-local tree without native scheme dispatch.
 */
export function createMemoryFileSystemProvider(
  options: MemoryFileSystemOptions = {},
): FileSystemProvider {
  const scheme = options.scheme ?? 'memfs';
  const capabilities =
    options.capabilities ??
    (Capability.ReadWrite |
      Capability.CaseSensitive |
      Capability.Watch |
      Capability.Clone |
      Capability.AtomicWrite);
  const caseSensitive = (capabilities & Capability.CaseSensitive) !== 0;
  const readonly = (capabilities & Capability.Readonly) !== 0;

  let nextId = 1;
  const nodes = new Map<string, MemNode>(); // path key → node
  const idToPath = new Map<number, string>(); // id → path key
  const watchers = new Set<(event: FileSystemEvent) => void>();

  function now(): number {
    return Date.now();
  }

  function emit(event: FileSystemEvent): void {
    for (const w of [...watchers]) {
      try {
        w(event);
      } catch {
        /* ignore watcher errors */
      }
    }
  }

  function uriFor(path: string): Uri {
    return createUri(scheme, path);
  }

  function getNode(path: string): MemNode | undefined {
    return nodes.get(pathKey(path, caseSensitive));
  }

  function ensureNode(path: string): MemNode {
    const n = getNode(path);
    if (!n) {
      throw new FileSystemError('ENOENT', `No such file or directory`, path);
    }
    return n;
  }

  function toEntry(node: MemNode, path: string): ProviderEntry {
    return {
      id: node.id,
      parentId: node.parentId,
      name: node.name,
      kind: node.kind,
      size: node.kind === EntryKind.File ? node.content.byteLength : 0,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      path: normalizeUriPath(path).replace(/^\//, ''),
      isReadonly: readonly,
    };
  }

  function allocId(): number {
    const id = nextId;
    nextId += 1;
    return id;
  }

  function mkdirp(path: string): MemNode {
    const key = pathKey(path, caseSensitive);
    const existing = nodes.get(key);
    if (existing) {
      if (existing.kind !== EntryKind.Directory) {
        throw new FileSystemError('ENOTDIR', 'Not a directory', path);
      }
      return existing;
    }
    const parentPath = dirnameUriPath(path);
    let parentId: number | null = null;
    if (normalizeUriPath(path) !== '/') {
      const parent = mkdirp(parentPath);
      parentId = parent.id;
      const name = basenameUriPath(path);
      parent.children.set(caseSensitive ? name : name.toLowerCase(), key);
    }
    const t = now();
    const node: MemNode = {
      id: allocId(),
      parentId,
      name: normalizeUriPath(path) === '/' ? '' : basenameUriPath(path),
      kind: EntryKind.Directory,
      content: new Uint8Array(0),
      mtimeMs: t,
      ctimeMs: t,
      children: new Map(),
    };
    nodes.set(key, node);
    idToPath.set(node.id, key);
    return node;
  }

  // Root
  mkdirp('/');

  // Seed directories
  for (const d of options.directories ?? []) {
    mkdirp(d);
  }

  // Seed files
  for (const [p, data] of Object.entries(options.files ?? {})) {
    const path = normalizeUriPath(p);
    mkdirp(dirnameUriPath(path));
    const parent = ensureNode(dirnameUriPath(path));
    const name = basenameUriPath(path);
    const key = pathKey(path, caseSensitive);
    if (nodes.has(key)) {
      throw new FileSystemError('EEXIST', 'File exists', path);
    }
    const t = now();
    const node: MemNode = {
      id: allocId(),
      parentId: parent.id,
      name,
      kind: EntryKind.File,
      content: toBytes(data),
      mtimeMs: t,
      ctimeMs: t,
      children: new Map(),
    };
    nodes.set(key, node);
    idToPath.set(node.id, key);
    parent.children.set(caseSensitive ? name : name.toLowerCase(), key);
    parent.mtimeMs = t;
  }

  function assertWritable(): void {
    if (readonly) {
      throw new FileSystemError('EROFS', 'Read-only file system');
    }
  }

  function assertSameScheme(uri: Uri): void {
    if (uri.scheme !== scheme) {
      throw new FileSystemError(
        'EINVAL',
        `URI scheme "${uri.scheme}" does not match provider "${scheme}"`,
        uri.path,
      );
    }
  }

  const provider: FileSystemProvider = {
    scheme,
    capabilities,

    async stat(uri) {
      assertSameScheme(uri);
      const node = ensureNode(uri.path);
      return toEntry(node, uri.path);
    },

    async readDirectory(uri) {
      assertSameScheme(uri);
      const node = ensureNode(uri.path);
      if (node.kind !== EntryKind.Directory) {
        throw new FileSystemError('ENOTDIR', 'Not a directory', uri.path);
      }
      const out: ProviderEntry[] = [];
      for (const childKey of node.children.values()) {
        const child = nodes.get(childKey);
        if (!child) continue;
        // Reconstruct display path from parent + name
        const childPath =
          normalizeUriPath(uri.path) === '/'
            ? `/${child.name}`
            : `${normalizeUriPath(uri.path)}/${child.name}`;
        out.push(toEntry(child, childPath));
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    },

    async readFile(uri) {
      assertSameScheme(uri);
      const node = ensureNode(uri.path);
      if (node.kind !== EntryKind.File) {
        throw new FileSystemError('EISDIR', 'Is a directory', uri.path);
      }
      return new Uint8Array(node.content);
    },

    async writeFile(uri, data) {
      assertWritable();
      assertSameScheme(uri);
      const path = normalizeUriPath(uri.path);
      const existing = getNode(path);
      const t = now();
      const bytes = new Uint8Array(data);
      if (existing) {
        if (existing.kind !== EntryKind.File) {
          throw new FileSystemError('EISDIR', 'Is a directory', path);
        }
        existing.content = bytes;
        existing.mtimeMs = t;
        emit({ type: 'changed', uri: uriFor(path) });
        return;
      }
      const parentPath = dirnameUriPath(path);
      const parent = ensureNode(parentPath);
      if (parent.kind !== EntryKind.Directory) {
        throw new FileSystemError('ENOTDIR', 'Not a directory', parentPath);
      }
      const name = basenameUriPath(path);
      const key = pathKey(path, caseSensitive);
      const node: MemNode = {
        id: allocId(),
        parentId: parent.id,
        name,
        kind: EntryKind.File,
        content: bytes,
        mtimeMs: t,
        ctimeMs: t,
        children: new Map(),
      };
      nodes.set(key, node);
      idToPath.set(node.id, key);
      parent.children.set(caseSensitive ? name : name.toLowerCase(), key);
      parent.mtimeMs = t;
      emit({ type: 'created', uri: uriFor(path) });
    },

    async createDirectory(uri) {
      assertWritable();
      assertSameScheme(uri);
      const path = normalizeUriPath(uri.path);
      if (getNode(path)) {
        throw new FileSystemError('EEXIST', 'File exists', path);
      }
      const parentPath = dirnameUriPath(path);
      const parent = ensureNode(parentPath);
      if (parent.kind !== EntryKind.Directory) {
        throw new FileSystemError('ENOTDIR', 'Not a directory', parentPath);
      }
      mkdirp(path);
      emit({ type: 'created', uri: uriFor(path) });
    },

    async delete(uri, options) {
      assertWritable();
      assertSameScheme(uri);
      const path = normalizeUriPath(uri.path);
      if (path === '/') {
        throw new FileSystemError('EACCES', 'Cannot delete root', path);
      }
      const node = ensureNode(path);
      if (node.kind === EntryKind.Directory && node.children.size > 0) {
        if (!options?.recursive) {
          throw new FileSystemError('EINVAL', 'Directory not empty', path);
        }
        // Recursive delete children first
        for (const childKey of [...node.children.values()]) {
          const child = nodes.get(childKey);
          if (!child) continue;
          const childPath =
            path === '/' ? `/${child.name}` : `${path}/${child.name}`;
          await provider.delete!(uriFor(childPath), { recursive: true });
        }
      }
      const parentPath = dirnameUriPath(path);
      const parent = getNode(parentPath);
      if (parent) {
        parent.children.delete(
          caseSensitive ? node.name : node.name.toLowerCase(),
        );
        parent.mtimeMs = now();
      }
      nodes.delete(pathKey(path, caseSensitive));
      idToPath.delete(node.id);
      emit({ type: 'deleted', uri: uriFor(path) });
    },

    async rename(oldUri, newUri) {
      assertWritable();
      assertSameScheme(oldUri);
      assertSameScheme(newUri);
      const from = normalizeUriPath(oldUri.path);
      const to = normalizeUriPath(newUri.path);
      if (from === '/') {
        throw new FileSystemError('EACCES', 'Cannot rename root', from);
      }
      if (from === to) return;
      const node = ensureNode(from);
      // Reject move into self or any descendant (would create a cycle).
      if (isPathUnder(to, from)) {
        throw new FileSystemError(
          'EINVAL',
          `Cannot move "${from}" into itself or a descendant`,
          to,
        );
      }
      if (getNode(to)) {
        throw new FileSystemError('EEXIST', 'File exists', to);
      }
      const newParentPath = dirnameUriPath(to);
      const newParent = ensureNode(newParentPath);
      if (newParent.kind !== EntryKind.Directory) {
        throw new FileSystemError('ENOTDIR', 'Not a directory', newParentPath);
      }
      const oldParentPath = dirnameUriPath(from);
      const oldParent = getNode(oldParentPath);
      if (oldParent) {
        oldParent.children.delete(
          caseSensitive ? node.name : node.name.toLowerCase(),
        );
      }
      const oldKey = pathKey(from, caseSensitive);
      nodes.delete(oldKey);

      const newName = basenameUriPath(to);
      node.name = newName;
      node.parentId = newParent.id;
      node.mtimeMs = now();
      const newKey = pathKey(to, caseSensitive);
      nodes.set(newKey, node);
      idToPath.set(node.id, newKey);
      newParent.children.set(
        caseSensitive ? newName : newName.toLowerCase(),
        newKey,
      );
      newParent.mtimeMs = node.mtimeMs;

      // Re-key descendants if directory
      if (node.kind === EntryKind.Directory) {
        rekeyDescendants(from, to, caseSensitive, nodes, idToPath);
      }

      emit({
        type: 'renamed',
        uri: uriFor(to),
        oldUri: uriFor(from),
      });
    },

    async copy(source, destination) {
      assertWritable();
      assertSameScheme(source);
      assertSameScheme(destination);
      const from = normalizeUriPath(source.path);
      const to = normalizeUriPath(destination.path);
      if (from === to || isPathUnder(to, from)) {
        throw new FileSystemError(
          'EINVAL',
          `Cannot copy "${from}" into itself or a descendant`,
          to,
        );
      }
      const src = ensureNode(from);
      if (src.kind === EntryKind.File) {
        await provider.writeFile!(destination, new Uint8Array(src.content));
        return;
      }
      await provider.createDirectory!(destination);
      for (const childKey of src.children.values()) {
        const child = nodes.get(childKey);
        if (!child) continue;
        const childSrc =
          from === '/' ? `/${child.name}` : `${from}/${child.name}`;
        const childDst = joinUriPath(to, child.name);
        await provider.copy!(uriFor(childSrc), uriFor(childDst));
      }
    },

    watch(uri, options) {
      assertSameScheme(uri);
      const scope = normalizeUriPath(uri.path);
      const recursive = options?.recursive !== false; // default true for memfs root demos
      const includes = options?.includes ?? [];
      const excludes = options?.excludes ?? [];
      const listeners = new Set<(e: FileSystemEvent) => void>();

      const forward = (e: FileSystemEvent): void => {
        if (!eventInWatchScope(e, scope, recursive, includes, excludes)) {
          return;
        }
        for (const l of listeners) l(e);
      };
      watchers.add(forward);
      const watcher: Watcher = {
        onDidChange(listener) {
          listeners.add(listener);
          return {
            dispose() {
              listeners.delete(listener);
            },
          };
        },
        dispose() {
          watchers.delete(forward);
          listeners.clear();
        },
      };
      return watcher;
    },
  };

  return provider;
}

/** True when `path` is `ancestor` or a path under it. */
export function isPathUnder(path: string, ancestor: string): boolean {
  const p = normalizeUriPath(path);
  const a = normalizeUriPath(ancestor);
  if (p === a) return true;
  if (a === '/') return p.startsWith('/');
  return p.startsWith(`${a}/`);
}

function eventInWatchScope(
  event: FileSystemEvent,
  scope: string,
  recursive: boolean,
  includes: readonly string[],
  excludes: readonly string[],
): boolean {
  const paths = [event.uri.path];
  if (event.oldUri) paths.push(event.oldUri.path);
  for (const raw of paths) {
    const p = normalizeUriPath(raw);
    if (!pathMatchesWatch(p, scope, recursive)) continue;
    if (excludes.some((g) => matchSimpleGlob(p, g))) continue;
    if (includes.length > 0 && !includes.some((g) => matchSimpleGlob(p, g))) {
      continue;
    }
    return true;
  }
  return false;
}

function pathMatchesWatch(
  path: string,
  scope: string,
  recursive: boolean,
): boolean {
  const p = normalizeUriPath(path);
  const s = normalizeUriPath(scope);
  if (p === s) return true;
  if (!isPathUnder(p, s)) return false;
  if (recursive) return true;
  // Non-recursive: only direct children of scope.
  const parent = dirnameUriPath(p);
  return parent === s;
}

/** Minimal `*` / `**` glob against POSIX path (no brace expansion). */
function matchSimpleGlob(path: string, pattern: string): boolean {
  const p = normalizeUriPath(path);
  const g = pattern.replace(/\\/g, '/');
  // Exact / prefix forms used in tests and host filters.
  if (g.endsWith('/**')) {
    const prefix = g.slice(0, -3);
    return isPathUnder(p, prefix === '' ? '/' : prefix);
  }
  if (g.includes('*')) {
    const re = new RegExp(
      `^${g
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '::DS::')
        .replace(/\*/g, '[^/]*')
        .replace(/::DS::/g, '.*')}$`,
    );
    return re.test(p);
  }
  return p === normalizeUriPath(g) || isPathUnder(p, g);
}

function rekeyDescendants(
  _oldPrefix: string,
  newPrefix: string,
  caseSensitive: boolean,
  nodes: Map<string, MemNode>,
  idToPath: Map<number, string>,
): void {
  const newP = normalizeUriPath(newPrefix);
  const root = nodes.get(pathKey(newP, caseSensitive));
  if (!root || root.kind !== EntryKind.Directory) return;

  function walk(dirPath: string, dir: MemNode): void {
    for (const [childName, childKey] of [...dir.children.entries()]) {
      const child = nodes.get(childKey);
      if (!child) continue;
      const childPath = joinUriPath(dirPath, child.name);
      const expectedKey = pathKey(childPath, caseSensitive);
      if (childKey !== expectedKey) {
        nodes.delete(childKey);
        nodes.set(expectedKey, child);
        idToPath.set(child.id, expectedKey);
        dir.children.set(childName, expectedKey);
      }
      if (child.kind === EntryKind.Directory) {
        walk(childPath, child);
      }
    }
  }
  walk(newP, root);
}
