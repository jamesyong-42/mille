// Minimal archival icon theme.
//
// The spaghetti-ui-design Structure panel is text-first: folders use
// [+]/[-] disclosure; files have no glyphs. This
// theme supplies empty 16×16 placeholders so the resolver still
// succeeds when a host passes iconTheme without the CSS hide rule.
// Prefer pairing with `@vibecook/mille-ui/theme/minimal.css` which
// hides [role="img"] and restyles the chevron as [+]/[-].

import type { IconTheme } from './types.js';

/** Empty spacer — keeps layout stable if icons are not CSS-hidden. */
const EMPTY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"></svg>';

export const minimalIconTheme: IconTheme = {
  id: 'mille-minimal',
  iconDefinitions: {
    _file: { inlineSvg: EMPTY_SVG },
    _folder: { inlineSvg: EMPTY_SVG },
    _folder_open: { inlineSvg: EMPTY_SVG },
  },
  file: '_file',
  folder: '_folder',
  folderExpanded: '_folder_open',
  // No extension / filename maps — everything falls back to _file.
  // hidesExplorerArrows is intentionally false: minimal.css restyles
  // the built-in chevron into [+]/[-] rather than removing it.
  hidesExplorerArrows: false,
};
