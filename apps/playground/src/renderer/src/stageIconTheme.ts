// Playground-only icon theme that matches the docs mock:
// solid blue folders + compact colored file tiles (not monoline glyphs).

import type { IconTheme } from '@vibecook/mille-ui/icons';

function svg(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">${inner}</svg>`;
}

/** Solid folder — closed (mock blue). */
const FOLDER = svg(
  `<path d="M1.5 3.25h4.1l1.15 1.35H14.5v8.15a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V3.25z" fill="#6b8cff"/>
   <path d="M1.5 3.25h4.1l1.15 1.35H1.5z" fill="#8aa4ff" opacity="0.9"/>`,
);

/** Solid folder — open. */
const FOLDER_OPEN = svg(
  `<path d="M1.5 4h4l1.2 1.4H14.5v1.6H1.5z" fill="#5a7aef"/>
   <path d="M1.5 7l1.4 5.75a1 1 0 0 0 .97.75H14.2a1 1 0 0 0 .97-1.25L14.5 7z" fill="#6b8cff"/>`,
);

/** Generic file tile. */
const FILE = svg(
  `<rect x="3" y="1.75" width="10" height="12.5" rx="1.6" fill="#2a3040" stroke="#4a5268" stroke-width="1"/>
   <path d="M5.25 5.5h5.5M5.25 8h5.5M5.25 10.5h3.5" stroke="#6b738a" stroke-width="1" stroke-linecap="round"/>`,
);

function fileTile(fill: string, stroke: string, mark?: string): string {
  const badge = mark
    ? `<text x="8" y="10.6" text-anchor="middle" font-family="ui-monospace,monospace" font-size="5.5" font-weight="700" fill="${stroke}">${mark}</text>`
    : `<path d="M5.25 5.5h5.5M5.25 8h5.5M5.25 10.5h3.5" stroke="${stroke}" stroke-opacity="0.55" stroke-width="1" stroke-linecap="round"/>`;
  return svg(
    `<rect x="3" y="1.75" width="10" height="12.5" rx="1.6" fill="${fill}" stroke="${stroke}" stroke-width="1.15"/>${badge}`,
  );
}

const FILE_TS = fileTile('#1a2438', '#7c9cff', 'TS');
const FILE_JS = fileTile('#2a2618', '#e3b341', 'JS');
const FILE_RS = fileTile('#2a1c16', '#e07a4c', 'RS');
const FILE_JSON = fileTile('#2a2618', '#c4a574', '{}');
const FILE_MD = fileTile('#1c2430', '#9aa3b5', 'MD');
const FILE_CSS = fileTile('#1a2234', '#82aaff', '#');
const FILE_TOML = fileTile('#242018', '#c4a574', 'T');
const FILE_LOCK = fileTile('#241c28', '#a78bfa', 'L');
const FILE_GIT = fileTile('#2a1c1c', '#f85149', 'G');
const FILE_PY = fileTile('#1c2430', '#4ad4b5', 'PY');
const FILE_GO = fileTile('#142428', '#4ad4b5', 'GO');

/**
 * Icon theme used by the playground IDE stage so the live FileTree
 * reads like the product mock in docs/index.html.
 */
export const stageIconTheme: IconTheme = {
  id: 'mille-playground-stage',
  iconDefinitions: {
    _file: { inlineSvg: FILE },
    _folder: { inlineSvg: FOLDER },
    _folder_open: { inlineSvg: FOLDER_OPEN },
    _ts: { inlineSvg: FILE_TS },
    _js: { inlineSvg: FILE_JS },
    _rs: { inlineSvg: FILE_RS },
    _json: { inlineSvg: FILE_JSON },
    _md: { inlineSvg: FILE_MD },
    _css: { inlineSvg: FILE_CSS },
    _toml: { inlineSvg: FILE_TOML },
    _lock: { inlineSvg: FILE_LOCK },
    _git: { inlineSvg: FILE_GIT },
    _py: { inlineSvg: FILE_PY },
    _go: { inlineSvg: FILE_GO },
  },
  file: '_file',
  folder: '_folder',
  folderExpanded: '_folder_open',
  fileExtensions: {
    ts: '_ts',
    tsx: '_ts',
    mts: '_ts',
    cts: '_ts',
    js: '_js',
    jsx: '_js',
    mjs: '_js',
    cjs: '_js',
    rs: '_rs',
    json: '_json',
    jsonc: '_json',
    md: '_md',
    markdown: '_md',
    mdx: '_md',
    css: '_css',
    scss: '_css',
    less: '_css',
    toml: '_toml',
    lock: '_lock',
    py: '_py',
    go: '_go',
    gitignore: '_git',
    gitattributes: '_git',
  },
  fileNames: {
    'package.json': '_json',
    'package-lock.json': '_lock',
    'pnpm-lock.yaml': '_lock',
    'cargo.lock': '_lock',
    'cargo.toml': '_toml',
    'readme.md': '_md',
    '.gitignore': '_git',
  },
};
