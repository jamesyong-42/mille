// Public entry for `@vibecook/mille-ui/icons/material`.
//
// Phase B5 — ships a real inlined bundle of the Material Icon Theme
// subset (MIT, by material-extensions/vscode-material-icon-theme). The
// bundle is vendored into `./icons/material/generated.ts` by the
// `scripts/build-material.mjs` publish-time script. See NOTICES.md for
// attribution; see the generated file header for the pinned version.
//
// The bundle is pulled in via a dynamic import so consumers who never
// call `loadMaterialIconTheme()` pay 0 bytes — their tree-shaker
// / bundler will keep the Material sub-bundle out of the main chunk.

import type { IconTheme } from './icons/types.js';

/**
 * Load the bundled Material Icon Theme. Returns an `IconTheme` whose
 * `iconDefinitions` carry pre-sanitized `inlineSvg` strings — no
 * network or DOM work happens at resolve time.
 *
 * The bundle covers the top ~150 most-common filetypes, framework
 * configs, lockfiles, and popular language icons. Filetypes outside
 * that set fall back to the theme default (`tokens.file` /
 * `tokens.folder`). For full coverage, bring your own VS Code-format
 * theme via `loadIconTheme({ url })`.
 */
export async function loadMaterialIconTheme(): Promise<IconTheme> {
  const mod = await import('./icons/material/generated.js');
  return mod.materialIconTheme;
}
