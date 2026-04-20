// Inline SVG sources for the default mille-ui icon set.
//
// Each SVG is kept under ~300 bytes, 16×16 viewBox, monoline. Colors
// are not hardcoded — strokes/fills use `currentColor` so the CSS
// consumer controls the tint via `color:`.
//
// Provenance: hand-drawn monoline glyphs, inspired by Codicons (MIT).
// These are not copies of any particular icon; they're bespoke to the
// project and licensed under this package's own MIT license.
//
// The strings here are considered pre-sanitized by construction (they
// never leave the package), so mille-ui consumers can render them
// without running sanitizeSvg() again.

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">';
const SVG_CLOSE = '</svg>';

function wrap(inner: string): string {
  return `${SVG_OPEN}${inner}${SVG_CLOSE}`;
}

// ── Generic file (blank page with a folded corner) ──────────────────
export const FILE_SVG = wrap(
  '<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/>',
);

// ── Generic folder ──────────────────────────────────────────────────
export const FOLDER_SVG = wrap(
  '<path d="M1.5 4.5h4l1.5 1.5h7.5v7.5h-13z"/>',
);

// ── Generic folder, open ────────────────────────────────────────────
export const FOLDER_OPEN_SVG = wrap(
  '<path d="M1.5 4.5h4l1.5 1.5h7.5v2.5h-13z"/><path d="M1.5 13.5l1.5-5h12.5l-1.5 5z"/>',
);

// ── File variants: simple page + a tiny letter glyph-block. We draw
// a 2-stroke "badge" instead of text to keep bytes small.
// The badge shape lets the renderer differentiate at a glance.

function fileWithBadge(badge: string): string {
  return wrap(
    `<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/>${badge}`,
  );
}

// TypeScript — upper-right dash + vertical stroke ("T")
export const FILE_TS_SVG = fileWithBadge(
  '<path d="M5 11h4m-2 0v-3"/>',
);

// JavaScript — curl (J)
export const FILE_JS_SVG = fileWithBadge(
  '<path d="M8 8v3a1 1 0 0 1-1 1"/>',
);

// JSON — curly braces
export const FILE_JSON_SVG = fileWithBadge(
  '<path d="M6 8c-1 0-1 1-1 1.5 0 .5 0 1-1 1 1 0 1 .5 1 1 0 .5 0 1.5 1 1.5m4-5c1 0 1 1 1 1.5 0 .5 0 1 1 1-1 0-1 .5-1 1 0 .5 0 1.5-1 1.5"/>',
);

// Markdown — MD (two peaks)
export const FILE_MD_SVG = fileWithBadge(
  '<path d="M5 12v-3l1.5 2 1.5-2v3"/>',
);

// Python — stacked circles
export const FILE_PY_SVG = fileWithBadge(
  '<circle cx="7" cy="9.5" r="1"/><circle cx="9" cy="12" r="1"/>',
);

// Rust — gear tooth
export const FILE_RS_SVG = fileWithBadge(
  '<path d="M5 11h3m0 0v-2m0 2l1.5 1.5"/>',
);

// Go — circle (pocket gopher)
export const FILE_GO_SVG = fileWithBadge(
  '<circle cx="7.5" cy="11" r="1.75"/>',
);

// CSS — hash + cascade
export const FILE_CSS_SVG = fileWithBadge(
  '<path d="M5 9.5h4m-4 2h4m-3-4v5m2-5v5"/>',
);

// HTML — angle brackets
export const FILE_HTML_SVG = fileWithBadge(
  '<path d="M7 8.5l-1.5 2L7 12.5m2-4l1.5 2L9 12.5"/>',
);

// YAML — two dashes
export const FILE_YAML_SVG = fileWithBadge(
  '<path d="M5 10h4m-4 2h4"/>',
);

// TOML — horizontal banner with cross-stroke
export const FILE_TOML_SVG = fileWithBadge(
  '<path d="M5 9h4m-2 0v3m-1 0h2"/>',
);

// Lockfile — padlock
export const FILE_LOCK_SVG = fileWithBadge(
  '<rect x="5.5" y="10" width="4" height="3" rx="0.5"/><path d="M6.25 10V9a1.25 1.25 0 0 1 2.5 0v1"/>',
);

// Git — ref dot on a branch
export const FILE_GIT_SVG = fileWithBadge(
  '<path d="M6 9v4"/><circle cx="6" cy="9" r="0.75"/><circle cx="6" cy="13" r="0.75"/><circle cx="9" cy="11" r="0.75"/><path d="M6 11h2.25"/>',
);

// .env — key glyph
export const FILE_ENV_SVG = fileWithBadge(
  '<circle cx="6" cy="11.5" r="1"/><path d="M7 11.5h3m-1 0v1"/>',
);

// Image — mountain + sun
export const FILE_IMAGE_SVG = fileWithBadge(
  '<circle cx="6" cy="9.5" r="0.6"/><path d="M5 13l2-2 1.5 1.5 1.5-2.5"/>',
);

// README — lines of text
export const FILE_README_SVG = fileWithBadge(
  '<path d="M5 9h4m-4 2h4m-4 2h2.5"/>',
);
