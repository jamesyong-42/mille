// Public entry for `@vibecook/mille-ui/icons/material`.
//
// v0.1 ships the entry point as a stub: the Material Icon Theme bundle
// is ~2 MB compressed and not a v0.1 deliverable. Consumers can still
// load it manually via `loadIconTheme({ url })` pointing at a copy of
// the upstream PKief/material-icon-theme JSON. This stub exists so the
// subpath export is stable and the upgrade to v0.3 is a drop-in.

import type { IconTheme } from './icons/types.js';

/**
 * Load the bundled Material Icon Theme. Returns a validated `IconTheme`.
 *
 * **v0.1 status:** not shipped. Throws on call. Use
 * `loadIconTheme({ url: '/path/to/material-icon-theme/index.json' })`
 * from `@vibecook/mille-ui/icons` to load a self-hosted copy.
 *
 * v0.3 will wire this up to a lazy dynamic import of the vendored
 * bundle; the resolved `IconTheme` shape will not change.
 */
export async function loadMaterialIconTheme(): Promise<IconTheme> {
  return Promise.reject(
    new Error(
      'Material Icon Theme bundle not shipped in v0.1; load manually via loadIconTheme({ url })',
    ),
  );
}
