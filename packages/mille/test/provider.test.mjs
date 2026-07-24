// Phase 6.1 — filesystem provider boundary + memfs + platform path helpers.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const {
  Capability,
  createMemoryFileSystemProvider,
  createProviderRegistry,
  createProviderTreeSession,
  providerRowsToVisibleRows,
  createUri,
  describeUnsupported,
  hardenProvider,
  isPathUnder,
  isUncPath,
  isWindowsDrivePath,
  parsePlatformPath,
  pathsEqual,
  providerSupports,
  providerSupportsOperation,
  withCapabilityGate,
  withOfflineGate,
  normalizeFileName,
  segmentsEscapeRoot,
} = await import('../dist/provider.js');

const { FileSystemError, isFileSystemError } = await import('../dist/index.js');

test('memfs: seed, list, read, write, rename, delete', async () => {
  const fs = createMemoryFileSystemProvider({
    files: {
      '/src/a.ts': 'hello',
      '/src/b.ts': 'world',
    },
    directories: ['/empty'],
  });

  const rootKids = await fs.readDirectory(createUri('memfs', '/'));
  assert.ok(rootKids.some((e) => e.name === 'src'));
  assert.ok(rootKids.some((e) => e.name === 'empty'));

  const srcKids = await fs.readDirectory(createUri('memfs', '/src'));
  assert.equal(srcKids.length, 2);

  const text = new TextDecoder().decode(
    await fs.readFile(createUri('memfs', '/src/a.ts')),
  );
  assert.equal(text, 'hello');

  await fs.writeFile(createUri('memfs', '/src/c.ts'), new TextEncoder().encode('new'));
  await fs.rename(
    createUri('memfs', '/src/c.ts'),
    createUri('memfs', '/src/d.ts'),
  );
  await assert.rejects(
    () => fs.stat(createUri('memfs', '/src/c.ts')),
    (e) => isFileSystemError(e) && e.code === 'ENOENT',
  );
  const d = await fs.stat(createUri('memfs', '/src/d.ts'));
  assert.equal(d.kind, 0);

  await fs.delete(createUri('memfs', '/src/d.ts'));
  await assert.rejects(() => fs.stat(createUri('memfs', '/src/d.ts')));
});

test('capability gate rejects mutations on readonly provider', async () => {
  const raw = createMemoryFileSystemProvider({
    capabilities: Capability.Readonly | Capability.CaseSensitive,
    files: { '/readme.md': 'x' },
  });
  const fs = withCapabilityGate(raw);

  assert.equal(providerSupports(fs.capabilities, 'writeFile'), false);
  assert.equal(providerSupports(fs.capabilities, 'readFile'), true);

  const info = describeUnsupported(fs.capabilities, 'writeFile');
  assert.equal(info.code, 'EUNSUPPORTED');
  assert.match(info.message, /read-only/i);

  await assert.rejects(
    () => fs.writeFile(createUri('memfs', '/x'), new TextEncoder().encode('1')),
    (e) => isFileSystemError(e) && e.code === 'EUNSUPPORTED',
  );

  const bytes = await fs.readFile(createUri('memfs', '/readme.md'));
  assert.equal(new TextDecoder().decode(bytes), 'x');
});

test('capability gate throws EUNSUPPORTED when method missing (not TypeError)', async () => {
  const partial = {
    scheme: 'partial',
    capabilities: Capability.ReadWrite,
    async stat() {
      return {
        id: 1,
        parentId: null,
        name: '',
        kind: 1,
        size: 0,
        mtimeMs: 0,
        ctimeMs: 0,
        path: '',
      };
    },
    async readDirectory() {
      return [];
    },
    async readFile() {
      return new Uint8Array();
    },
    // ReadWrite advertised but no delete/writeFile/rename…
  };
  const fs = withCapabilityGate(partial);
  assert.equal(typeof fs.delete, 'undefined');
  assert.equal(providerSupportsOperation(partial, 'delete'), false);
  assert.match(
    describeUnsupported(partial.capabilities, 'delete', partial).message,
    /does not implement delete/i,
  );

  // Direct require via fabricated call site:
  const gated = withCapabilityGate({
    ...partial,
    // Force surface with a wrapper that still gates:
    async delete() {
      throw new Error('should not be reached');
    },
  });
  // Actually full memfs missing method test:
  const onlyWrite = {
    scheme: 'w',
    capabilities: Capability.ReadWrite,
    async stat(uri) {
      return {
        id: 1,
        parentId: null,
        name: 'x',
        kind: 0,
        size: 0,
        mtimeMs: 0,
        ctimeMs: 0,
        path: uri.path.replace(/^\//, ''),
      };
    },
    async readDirectory() {
      return [];
    },
    async readFile() {
      return new Uint8Array();
    },
    async writeFile() {},
    // no delete
  };
  const g = withCapabilityGate(onlyWrite);
  assert.equal(typeof g.delete, 'undefined');
  assert.equal(typeof g.writeFile, 'function');
  // If host still has a reference that calls delete through harden path:
  await assert.rejects(async () => {
    // Simulate gate on missing: withCapabilityGate omits method; calling
    // require via providerSupportsOperation is the public check.
    const { requireCapability } = await import('../dist/provider.js');
    requireCapability(onlyWrite, 'delete');
  }, (e) => isFileSystemError(e) && e.code === 'EUNSUPPORTED');
  void gated;
});

test('registry out-of-order dispose does not resurrect disposed providers', () => {
  const reg = createProviderRegistry();
  const a = createMemoryFileSystemProvider({ scheme: 'memfs', files: { '/a': 'a' } });
  const b = createMemoryFileSystemProvider({ scheme: 'memfs', files: { '/b': 'b' } });
  const c = createMemoryFileSystemProvider({ scheme: 'memfs', files: { '/c': 'c' } });
  const dA = reg.register(a);
  const dB = reg.register(b);
  const dC = reg.register(c);
  assert.equal(reg.get('memfs'), c);
  dB.dispose(); // mid-stack
  assert.equal(reg.get('memfs'), c); // still C
  dC.dispose();
  assert.equal(reg.get('memfs'), a); // A, not resurrected B
  dA.dispose();
  assert.equal(reg.get('memfs'), undefined);
});

test('registry LIFO dispose still works', () => {
  const reg = createProviderRegistry();
  const a = createMemoryFileSystemProvider({ scheme: 'memfs' });
  const b = createMemoryFileSystemProvider({ scheme: 'memfs' });
  const d1 = reg.register(a);
  const d2 = reg.register(b);
  assert.equal(reg.get('memfs'), b);
  d2.dispose();
  assert.equal(reg.get('memfs'), a);
  d1.dispose();
  assert.equal(reg.get('memfs'), undefined);
});

test('memfs rejects rename/copy into self or descendant', async () => {
  const fs = createMemoryFileSystemProvider({
    files: { '/a/b/c.ts': 'x' },
    directories: ['/a/b'],
  });
  await assert.rejects(
    () =>
      fs.rename(createUri('memfs', '/a'), createUri('memfs', '/a/b/a')),
    (e) => isFileSystemError(e) && e.code === 'EINVAL',
  );
  await assert.rejects(
    () =>
      fs.copy(createUri('memfs', '/a'), createUri('memfs', '/a/b/copy-of-a')),
    (e) => isFileSystemError(e) && e.code === 'EINVAL',
  );
  // Source still intact
  const kids = await fs.readDirectory(createUri('memfs', '/a'));
  assert.ok(kids.some((e) => e.name === 'b'));
  assert.equal(isPathUnder('/a/b/a', '/a'), true);
  assert.equal(isPathUnder('/x', '/a'), false);
});

test('memfs watch respects scope, recursive, excludes', async () => {
  const fs = createMemoryFileSystemProvider({
    directories: ['/left', '/right'],
    files: { '/left/a.txt': '1' },
  });
  const leftEvents = [];
  const rightEvents = [];
  const left = fs.watch(createUri('memfs', '/left'), { recursive: true });
  left.onDidChange((e) => leftEvents.push(e.uri.path));
  const right = fs.watch(createUri('memfs', '/right'), { recursive: true });
  right.onDidChange((e) => rightEvents.push(e.uri.path));

  await fs.writeFile(
    createUri('memfs', '/right/new.txt'),
    new TextEncoder().encode('x'),
  );
  assert.equal(leftEvents.length, 0);
  assert.ok(rightEvents.some((p) => p.includes('new.txt')));

  const shallow = fs.watch(createUri('memfs', '/left'), { recursive: false });
  const shallowEv = [];
  shallow.onDidChange((e) => shallowEv.push(e.uri.path));
  await fs.createDirectory(createUri('memfs', '/left/nested'));
  await fs.writeFile(
    createUri('memfs', '/left/nested/deep.txt'),
    new TextEncoder().encode('d'),
  );
  // Non-recursive sees nested dir create (direct child) but not deep.txt
  assert.ok(shallowEv.some((p) => p.endsWith('/left/nested')));
  assert.ok(!shallowEv.some((p) => p.includes('deep.txt')));

  const filtered = fs.watch(createUri('memfs', '/left'), {
    recursive: true,
    excludes: ['/left/nested/**'],
  });
  const filteredEv = [];
  filtered.onDidChange((e) => filteredEv.push(e.uri.path));
  await fs.writeFile(
    createUri('memfs', '/left/top.txt'),
    new TextEncoder().encode('t'),
  );
  await fs.writeFile(
    createUri('memfs', '/left/nested/skip.txt'),
    new TextEncoder().encode('s'),
  );
  assert.ok(filteredEv.some((p) => p.includes('top.txt')));
  assert.ok(!filteredEv.some((p) => p.includes('skip.txt')));

  left.dispose();
  right.dispose();
  shallow.dispose();
  filtered.dispose();
});

test('provider tree session single-flight refresh under write burst', async () => {
  const files = {};
  for (let i = 0; i < 200; i += 1) {
    files[`/d/f${i}.ts`] = `${i}`;
  }
  const fs = createMemoryFileSystemProvider({ files });
  const session = createProviderTreeSession(fs, createUri('memfs', '/'), {
    debounceMs: 5,
  });
  await session.refresh();

  let notifications = 0;
  session.onDidChange(() => {
    notifications += 1;
  });

  const writes = 50;
  for (let i = 0; i < writes; i += 1) {
    await fs.writeFile(
      createUri('memfs', `/d/f${i}.ts`),
      new TextEncoder().encode(`w${i}`),
    );
  }
  // Allow debounce + trailing refresh to settle
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(
    notifications < writes,
    `expected coalesced notifications < ${writes}, got ${notifications}`,
  );
  assert.ok(notifications >= 1, 'at least one refresh notification');

  const snap = session.getSnapshot();
  assert.ok(snap);
  // Empty expanded ⇒ root open with children visible
  const rows = snap.flatten(new Set());
  assert.ok(rows.some((r) => r.entry.name === 'd'));
  session.dispose();
});

test('explicit refresh observes a mutation made during an in-flight walk', async () => {
  // Joining an in-flight walk let refresh() resolve with a tree read *before*
  // the caller's own write. The gate below holds the first walk open at the
  // exact point where it has already read /d1's children, so the write cannot
  // be picked up by that walk — only by one started afterwards.
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const readD1 = deferred();
  const release = deferred();

  const files = {};
  for (let d = 1; d <= 3; d += 1) files[`/d${d}/f.ts`] = 'x';
  const mem = createMemoryFileSystemProvider({ files });

  const gated = {
    scheme: mem.scheme,
    capabilities: mem.capabilities,
    stat: (uri) => mem.stat(uri),
    readFile: (uri) => mem.readFile(uri),
    watch: (uri, opts) => mem.watch(uri, opts),
    async readDirectory(uri) {
      const out = await mem.readDirectory(uri);
      if (uri.path === '/d1') {
        // Children of /d1 are captured; hold the walk here.
        readD1.resolve();
        await release.promise;
      }
      return out;
    },
  };

  const session = createProviderTreeSession(gated, undefined, {
    debounceMs: 5,
  });
  const firstWalk = session.refresh();
  await readD1.promise;

  await mem.writeFile(
    createUri('memfs', '/d1/late.ts'),
    new TextEncoder().encode('late'),
  );
  const second = session.refresh();
  release.resolve();

  const snap = await second;
  const expanded = new Set([
    snap.root.entry.id,
    ...snap.root.children.map((c) => c.entry.id),
  ]);
  assert.ok(
    snap.flatten(expanded).some((r) => r.entry.name === 'late.ts'),
    'refresh() resolved with a snapshot that predates the caller mutation',
  );

  // The first walk still resolves with its own (older) view rather than hanging.
  const firstSnap = await firstWalk;
  assert.ok(firstSnap.version < snap.version);

  session.dispose();
});

test('provider tree flatten empty set shows root children', async () => {
  const fs = createMemoryFileSystemProvider({
    files: { '/a/one.ts': '1', '/b/x.ts': 'x' },
  });
  const session = createProviderTreeSession(fs);
  const snap = await session.refresh();
  const rows = snap.flatten(new Set());
  assert.ok(rows.some((r) => r.entry.name === 'a'));
  assert.ok(rows.some((r) => r.entry.name === 'b'));
  // Explicit expand none of children — only root-level when root expanded
  const onlyRoot = snap.flatten(new Set([snap.root.entry.id]));
  assert.ok(onlyRoot.some((r) => r.entry.name === 'a'));

  // Adapter for FileTree / fake engine visible rows
  const visible = providerRowsToVisibleRows(onlyRoot);
  assert.ok(visible.every((r) => typeof r.id === 'number'));
  assert.ok(visible.some((r) => r.name === 'a' && r.depth === 1));
  session.dispose();
});

test('offline gate blocks ops until reconnected', async () => {
  const raw = createMemoryFileSystemProvider({
    files: { '/a.txt': 'a' },
  });
  const { provider, offline } = withOfflineGate(raw);
  offline.setOffline(true);
  await assert.rejects(
    () => provider.readFile(createUri('memfs', '/a.txt')),
    (e) => isFileSystemError(e) && e.code === 'EBUSY',
  );
  offline.setOffline(false);
  const bytes = await provider.readFile(createUri('memfs', '/a.txt'));
  assert.equal(new TextDecoder().decode(bytes), 'a');
});

test('hardenProvider applies capability gate', async () => {
  const fs = hardenProvider(
    createMemoryFileSystemProvider({
      capabilities: Capability.Readonly,
      files: { '/z': 'z' },
    }),
  );
  await assert.rejects(() => fs.delete(createUri('memfs', '/z')));
});

test('platform path: Windows drive and UNC', () => {
  assert.equal(isWindowsDrivePath('C:\\Users\\x'), true);
  assert.equal(isUncPath('\\\\server\\share\\a'), true);
  assert.equal(isUncPath('//server/share/a'), true);

  const drive = parsePlatformPath('C:\\foo\\bar');
  assert.equal(drive.drive, 'C');
  assert.equal(drive.posixPath, '/C:/foo/bar');

  const unc = parsePlatformPath('\\\\files\\team\\docs\\a.md');
  assert.equal(unc.uncServer, 'files');
  assert.equal(unc.uncShare, 'team');
  assert.match(unc.posixPath, /\/\/files\/team/);
});

test('platform path: unicode + case policy + escape', () => {
  const nfc = normalizeFileName('\u00e9', 'NFC');
  const nfd = 'e\u0301'.normalize('NFD');
  assert.equal(
    pathsEqual(nfc, nfd, { caseSensitive: true, unicodeForm: 'NFC' }),
    true,
  );
  assert.equal(pathsEqual('A/B', 'a/b', { caseSensitive: false }), true);
  assert.equal(pathsEqual('A/B', 'a/b', { caseSensitive: true }), false);
  assert.equal(segmentsEscapeRoot(['..', 'x']), true);
  assert.equal(segmentsEscapeRoot(['a', '..', 'b']), false);
});
