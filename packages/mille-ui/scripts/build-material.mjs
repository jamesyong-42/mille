#!/usr/bin/env node
// Phase B5.1 — build-time fetcher for the Material Icon Theme bundle.
//
// Downloads the upstream VSIX from Open VSX (pinned version), parses
// `dist/material-icons.json`, then reads and sanitizes a SUBSET of the
// SVGs (the most-commonly-encountered ~150 icons) to keep the shipped
// bundle gzipped under 120 KB. The full upstream set ships 1221 icons
// at ~5 MB raw — way over the budget for a tree-shakeable dynamic
// import inlined into a library bundle.
//
// Output:
//   - src/icons/material/generated.ts   — the inlined IconTheme.
//   - src/icons/material/sources.json   — pinned version + fetched-at.
//
// The script is deliberately dependency-free beyond `happy-dom` and
// Node's stdlib: no npm fetch of `yauzl` or `adm-zip`. We use the
// `unzip` CLI (POSIX) — if it's missing, we fall back to `bsdtar`
// (macOS default) or emit a stub.
//
// Upstream provenance: PKief / material-extensions / vscode-material-
// icon-theme (MIT). See NOTICES.md in this package.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// ─── Configuration ────────────────────────────────────────────────────

// Pinned upstream version. Bump and re-run to refresh.
const UPSTREAM_VERSION = '5.33.1';
const VSIX_URL = `https://open-vsx.org/api/PKief/material-icon-theme/${UPSTREAM_VERSION}/file/PKief.material-icon-theme-${UPSTREAM_VERSION}.vsix`;

// Subset of upstream icon ids to include. Keeps the generated bundle
// under 120 KB gzipped while covering the top ~150 common filetypes,
// framework configs, lockfiles, and popular language / tooling icons.
//
// The build script warns and skips (without failing) any ids missing
// from the upstream JSON — upstream sometimes renames ids across
// versions.
const ICON_SUBSET = [
  // Defaults (required).
  'file', 'folder', 'folder-open', 'folder-root', 'folder-root-open',
  // Generic folders
  'folder-src', 'folder-src-open',
  'folder-test', 'folder-test-open',
  'folder-dist', 'folder-dist-open',
  'folder-docs', 'folder-docs-open',
  'folder-config', 'folder-config-open',
  'folder-components', 'folder-components-open',
  'folder-node', 'folder-node-open',
  'folder-public', 'folder-public-open',
  'folder-assets', 'folder-assets-open',
  'folder-images', 'folder-images-open',
  'folder-scripts', 'folder-scripts-open',
  'folder-styles', 'folder-styles-open',
  'folder-hooks', 'folder-hooks-open',
  'folder-utils', 'folder-utils-open',
  'folder-helper', 'folder-helper-open',
  'folder-views', 'folder-views-open',
  'folder-github', 'folder-github-open',
  'folder-vscode', 'folder-vscode-open',
  'folder-git', 'folder-git-open',
  'folder-typescript', 'folder-typescript-open',
  'folder-javascript', 'folder-javascript-open',
  // Language/file-type icons
  'typescript', 'typescript-def',
  'react', 'react_ts',
  'javascript', 'javascript-map',
  'json', 'yaml', 'xml', 'toml',
  'html', 'css', 'sass', 'less', 'stylus',
  'tailwindcss',
  'markdown', 'readme',
  'python', 'python-misc',
  'rust', 'ruby', 'go', 'go-mod',
  'php', 'java', 'kotlin', 'swift',
  'c', 'cpp', 'csharp', 'h', 'hpp',
  'shader', 'sol', 'solidity',
  'shell', 'powershell', 'bat', 'console',
  'dart', 'flutter', 'elixir', 'erlang',
  'haskell', 'lua', 'r', 'julia', 'scala',
  'clojure', 'nim', 'crystal', 'zig',
  'vue', 'svelte', 'angular',
  'graphql', 'prisma', 'astro',
  'git', 'gitignore', 'gitlab', 'github',
  'docker', 'kubernetes', 'terraform',
  'webpack', 'rollup', 'vite', 'turbo', 'nx',
  'eslint', 'prettier', 'stylelint', 'editorconfig',
  'babel', 'postcss', 'commitlint', 'husky',
  'jest', 'mocha', 'playwright', 'cypress', 'vitest',
  'storybook', 'test-ts', 'test-js',
  'env', 'lock', 'npm', 'pnpm', 'yarn', 'bun',
  'nodejs', 'deno',
  'log', 'database', 'sql', 'prisma',
  'font', 'image', 'video', 'audio',
  'pdf', 'zip', 'exe', 'binary',
  'cmake', 'makefile', 'ninja',
  'gradle', 'maven',
  'readme', 'license', 'authors', 'contributing', 'changelog',
  'cargo', 'rustfmt',
  'vscode', 'settings',
  'nuxt', 'next', 'gatsby', 'remix',
  'pnpm-workspace', 'npmrc',
  'certificate', 'key',
  'tsconfig',
];

// Extension / filename / language id keys to carry over. We keep any
// upstream mapping whose value is included in ICON_SUBSET — this gives
// us coverage for hundreds of extensions without dragging in SVGs.
const SUBSET_SET = new Set(ICON_SUBSET);

// ─── Paths ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(PKG_ROOT, 'src/icons/material');
const OUT_TS = resolve(OUT_DIR, 'generated.ts');
const OUT_SOURCES = resolve(OUT_DIR, 'sources.json');

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const workDir = join(tmpdir(), `mille-material-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  let fetched = false;
  try {
    const vsixPath = join(workDir, 'material-icon-theme.vsix');
    log(`fetching ${VSIX_URL}`);
    await downloadVsix(VSIX_URL, vsixPath);
    fetched = true;

    log(`extracting VSIX to ${workDir}`);
    extractVsix(vsixPath, workDir);

    const jsonPath = join(workDir, 'extension/dist/material-icons.json');
    const iconsDir = join(workDir, 'extension/icons');

    const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));

    log('sanitizing subset of icons');
    const { theme, kept, skipped, errors } = await buildTheme(raw, iconsDir);

    writeFileSync(OUT_TS, emitTs(theme), 'utf8');
    writeFileSync(
      OUT_SOURCES,
      JSON.stringify(
        {
          upstream: 'material-extensions/vscode-material-icon-theme',
          version: UPSTREAM_VERSION,
          license: 'MIT',
          fetchedAt: new Date().toISOString(),
          source: VSIX_URL,
          kept,
          skipped,
          sanitizationErrors: errors,
        },
        null,
        2,
      ),
      'utf8',
    );

    log(`wrote ${OUT_TS} — kept ${kept} icons, skipped ${skipped}, sanitize errors ${errors}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[build-material] ${fetched ? 'processing' : 'fetch'} failed: ${msg}`);
    console.warn('[build-material] emitting STUB generated.ts — Material bundle will be incomplete.');
    writeFileSync(OUT_TS, emitStub(msg), 'utf8');
    writeFileSync(
      OUT_SOURCES,
      JSON.stringify(
        {
          upstream: 'material-extensions/vscode-material-icon-theme',
          version: UPSTREAM_VERSION,
          license: 'MIT',
          fetchedAt: new Date().toISOString(),
          source: VSIX_URL,
          stub: true,
          error: msg,
        },
        null,
        2,
      ),
      'utf8',
    );
    // Exit 0 — CI shouldn't die if the network is unreachable; the
    // stub is clearly marked.
    return;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ─── Network ──────────────────────────────────────────────────────────

async function downloadVsix(url, outPath) {
  // Node 20+ has global fetch. Stream to disk via Response.arrayBuffer.
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  writeFileSync(outPath, buf);
}

// ─── Unzip ────────────────────────────────────────────────────────────

function extractVsix(vsixPath, outDir) {
  // Try `unzip` first, then `bsdtar` (macOS default).
  const attempts = [
    ['unzip', ['-qq', '-o', vsixPath, '-d', outDir]],
    ['bsdtar', ['-xf', vsixPath, '-C', outDir]],
    ['tar', ['-xf', vsixPath, '-C', outDir]],
  ];
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (r.status === 0) return;
  }
  throw new Error('no working unzip/bsdtar/tar found on PATH');
}

// ─── Theme build ──────────────────────────────────────────────────────

async function buildTheme(raw, iconsDir) {
  // Lazily spin up happy-dom for sanitize.
  const { Window } = await import('happy-dom');
  const win = new Window();
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.DOMParser = win.DOMParser;
  globalThis.XMLSerializer = win.XMLSerializer;

  // Import our sanitizer from the source tree (ts-stripped import:
  // build-material runs BEFORE the package's `tsc`, so we point at
  // the existing compiled `dist/` output if present. If not, we do a
  // minimal in-script sanitize based on the same allowlist).
  const sanitize = await loadSanitizer();

  const defs = raw.iconDefinitions || {};

  // First pass: which ids will we actually ship? ICON_SUBSET, filtered
  // to those upstream actually defines.
  const keptIds = new Set();
  const skippedIds = [];
  let sanitizeErrors = 0;

  const iconDefinitions = {};
  for (const id of ICON_SUBSET) {
    const def = defs[id];
    if (!def) {
      skippedIds.push(id);
      continue;
    }
    const iconPath = def.iconPath;
    if (!iconPath) {
      skippedIds.push(id);
      continue;
    }
    // iconPath is e.g. "./../icons/typescript.svg". Resolve against
    // the JSON's location (extension/dist/), which means the real file
    // lives at extension/icons/.
    const fileName = iconPath.split('/').pop();
    const svgPath = join(iconsDir, fileName);
    let svg;
    try {
      svg = readFileSync(svgPath, 'utf8');
    } catch {
      skippedIds.push(id);
      continue;
    }
    let cleaned;
    try {
      cleaned = sanitize(svg);
    } catch (err) {
      sanitizeErrors += 1;
      skippedIds.push(id);
      continue;
    }
    iconDefinitions[id] = { inlineSvg: cleaned };
    keptIds.add(id);
  }

  // Filter mappings: only keep keys whose value is in keptIds.
  const keepMap = (src) => {
    if (!src) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(src)) {
      if (keptIds.has(v)) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const root = {
    iconDefinitions,
    file: keptIds.has(raw.file) ? raw.file : 'file',
    folder: keptIds.has(raw.folder) ? raw.folder : 'folder',
    folderExpanded: keptIds.has(raw.folderExpanded) ? raw.folderExpanded : 'folder-open',
  };
  if (keptIds.has(raw.rootFolder)) root.rootFolder = raw.rootFolder;
  if (keptIds.has(raw.rootFolderExpanded)) root.rootFolderExpanded = raw.rootFolderExpanded;

  const fileExtensions = keepMap(raw.fileExtensions);
  const fileNames = keepMap(raw.fileNames);
  const languageIds = keepMap(raw.languageIds);
  const folderNames = keepMap(raw.folderNames);
  const folderNamesExpanded = keepMap(raw.folderNamesExpanded);

  // Upstream Material relies on VS Code's languageId to map `ts` / `js`
  // extensions — which mille-ui consumers won't have populated unless
  // they run a language detector. Inject ext fallbacks derived from
  // `languageIds` so common extensions Just Work without an engine
  // language field. These only apply when the key isn't already in
  // `fileExtensions` (upstream wins).
  const extFallbacks = {
    ts: 'typescript', mts: 'typescript', cts: 'typescript',
    'd.ts': 'typescript-def',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    md: 'markdown', mdx: 'markdown', markdown: 'markdown',
    py: 'python', pyi: 'python',
    rs: 'rust', go: 'go',
    php: 'php', java: 'java', kt: 'kotlin', swift: 'swift',
    c: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hh: 'hpp',
    cs: 'csharp', rb: 'ruby', sh: 'shell', bash: 'shell', zsh: 'shell',
    ps1: 'powershell', bat: 'bat', cmd: 'bat',
    ex: 'elixir', exs: 'elixir', erl: 'erlang',
    hs: 'haskell', lua: 'lua', dart: 'dart',
    vue: 'vue', svelte: 'svelte',
    graphql: 'graphql', gql: 'graphql',
    sol: 'solidity', zig: 'zig', nim: 'nim', clj: 'clojure',
    env: 'env', log: 'log', pdf: 'pdf', zip: 'zip', sql: 'sql',
  };
  const mergedExt = { ...(fileExtensions || {}) };
  for (const [ext, id] of Object.entries(extFallbacks)) {
    if (!(ext in mergedExt) && keptIds.has(id)) {
      mergedExt[ext] = id;
    }
  }
  if (Object.keys(mergedExt).length > 0) root.fileExtensions = mergedExt;

  if (fileNames) root.fileNames = fileNames;
  if (languageIds) root.languageIds = languageIds;
  if (folderNames) root.folderNames = folderNames;
  if (folderNamesExpanded) root.folderNamesExpanded = folderNamesExpanded;

  const theme = { id: 'material', ...root };

  // Light variant — the upstream splits only light, no dark. Map it.
  if (raw.light) {
    const lightFileExt = keepMap(raw.light.fileExtensions);
    const lightFileNames = keepMap(raw.light.fileNames);
    const lightLangIds = keepMap(raw.light.languageIds);
    const lightFolderNames = keepMap(raw.light.folderNames);
    const lightFolderExp = keepMap(raw.light.folderNamesExpanded);
    // Only emit light slice if any of these survived.
    if (lightFileExt || lightFileNames || lightLangIds || lightFolderNames || lightFolderExp) {
      const light = { iconDefinitions: {} };
      if (lightFileExt) light.fileExtensions = lightFileExt;
      if (lightFileNames) light.fileNames = lightFileNames;
      if (lightLangIds) light.languageIds = lightLangIds;
      if (lightFolderNames) light.folderNames = lightFolderNames;
      if (lightFolderExp) light.folderNamesExpanded = lightFolderExp;
      theme.light = light;
    }
  }

  await win.happyDOM.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.DOMParser;
  delete globalThis.XMLSerializer;

  return {
    theme,
    kept: keptIds.size,
    skipped: skippedIds.length,
    errors: sanitizeErrors,
  };
}

async function loadSanitizer() {
  // Prefer the built `dist/icons/sanitize.js` (already compiled from TS).
  const distPath = resolve(PKG_ROOT, 'dist/icons/sanitize.js');
  try {
    statSync(distPath);
    const mod = await import(distPath);
    return (s) => mod.sanitizeSvg(s);
  } catch {
    // Fall back to the built-in minimal sanitizer below.
    return minimalSanitize;
  }
}

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'path', 'circle', 'rect', 'polygon', 'polyline', 'line',
  'ellipse', 'defs', 'use', 'symbol', 'title', 'desc',
  'lineargradient', 'radialgradient', 'stop',
]);

const ALLOWED_ATTRS = new Set([
  'viewBox', 'width', 'height', 'd', 'fill', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'cx', 'cy', 'r', 'x', 'y',
  'x1', 'y1', 'x2', 'y2', 'points', 'rx', 'ry', 'transform', 'opacity',
  'fill-opacity', 'stroke-opacity', 'id', 'href', 'xlink:href',
  'gradientUnits', 'offset', 'stop-color', 'stop-opacity',
  'xmlns', 'xmlns:xlink', 'gradientTransform', 'spreadMethod',
  'preserveAspectRatio',
]);

function minimalSanitize(svg) {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
    throw new Error('minimalSanitize requires DOMParser');
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') {
    throw new Error('not an SVG');
  }
  filterAttrs(root);
  walk(root);
  return new XMLSerializer().serializeToString(root);
}

function walk(node) {
  const children = Array.from(node.childNodes);
  for (const child of children) {
    const nodeType = child.nodeType;
    if (nodeType === 1) {
      const tag = child.nodeName.toLowerCase();
      if (!ALLOWED_ELEMENTS.has(tag)) {
        child.parentNode?.removeChild(child);
        continue;
      }
      filterAttrs(child);
      walk(child);
    } else if (nodeType === 8 || nodeType === 4) {
      child.parentNode?.removeChild(child);
    }
  }
}

function filterAttrs(el) {
  const attrs = Array.from(el.attributes);
  for (const attr of attrs) {
    const name = attr.name;
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) { el.removeAttribute(name); continue; }
    if (!ALLOWED_ATTRS.has(name) && !ALLOWED_ATTRS.has(lower)) {
      el.removeAttribute(name);
      continue;
    }
    if (lower === 'href' || lower === 'xlink:href') {
      const v = attr.value.trim();
      if (!v.startsWith('#')) el.removeAttribute(name);
    }
    if (lower === 'style') el.removeAttribute(name);
  }
}

// ─── Emit ─────────────────────────────────────────────────────────────

function emitTs(theme) {
  // Pretty-print — small savings from minification aren't worth the
  // diff-noise on re-runs. Gzip handles the repetition.
  const header =
    '// AUTOGENERATED by scripts/build-material.mjs — DO NOT EDIT BY HAND.\n' +
    '//\n' +
    '// Subset of the Material Icon Theme (MIT) by material-extensions.\n' +
    '// Upstream: https://github.com/material-extensions/vscode-material-icon-theme\n' +
    `// Pinned version: v${UPSTREAM_VERSION}\n` +
    '//\n' +
    '// See NOTICES.md for full attribution.\n\n' +
    "import type { IconTheme } from '../types.js';\n\n";

  const body = 'export const materialIconTheme: IconTheme = ' + jsonStringify(theme) + ';\n';
  return header + body;
}

function emitStub(reason) {
  return (
    '// AUTOGENERATED by scripts/build-material.mjs — STUB FALLBACK.\n' +
    '//\n' +
    '// The build-material script could not fetch the upstream bundle\n' +
    '// (likely offline CI). The Material theme will resolve to defaults\n' +
    '// only; call sites should handle this gracefully.\n' +
    `// Reason: ${reason.replace(/\*\//g, '*\\/')}\n\n` +
    "import type { IconTheme } from '../types.js';\n\n" +
    'export const materialIconTheme: IconTheme = {\n' +
    "  id: 'material',\n" +
    '  iconDefinitions: {\n' +
    "    _stub_file: { inlineSvg: '<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><path d=\"M3.5 1.5h6l3 3v10h-9z\" fill=\"none\" stroke=\"currentColor\"/></svg>' },\n" +
    "    _stub_folder: { inlineSvg: '<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><path d=\"M1.5 4.5h4l1.5 1.5h7.5v7.5h-13z\" fill=\"none\" stroke=\"currentColor\"/></svg>' },\n" +
    '  },\n' +
    "  file: '_stub_file',\n" +
    "  folder: '_stub_folder',\n" +
    "  folderExpanded: '_stub_folder',\n" +
    '};\n\n' +
    '/** True when the generated bundle is a fallback stub. */\n' +
    'export const MATERIAL_THEME_IS_STUB = true as const;\n'
  );
}

// Deterministic JSON stringify — keys sorted for stable diffs.
function jsonStringify(value, indent = 2) {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = sortKeys(v[k]);
    }
    return out;
  }
  return v;
}

function log(msg) {
  console.log(`[build-material] ${msg}`);
}

main().catch((err) => {
  console.error('[build-material] fatal', err);
  process.exit(1);
});
