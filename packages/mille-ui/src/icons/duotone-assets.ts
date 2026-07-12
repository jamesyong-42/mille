// Soft-duotone SVG glyphs for the duotone icon theme.
// Filled blue folders + dark file body with a language color chip.
// Authored for dark IDE chrome; chips stay readable on light via contrast.

function svg(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none">${inner}</svg>`;
}

/** Closed folder — soft blue fill. */
export const DUOTONE_FOLDER = svg(
  `<path d="M1.5 3.25h4.1l1.15 1.35H14.5v8.15a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V3.25z" fill="#4a6ad4"/>
   <path d="M1.5 3.25h4.1l1.15 1.35H1.5z" fill="#6b8cff" opacity="0.95"/>`,
);

/** Open folder. */
export const DUOTONE_FOLDER_OPEN = svg(
  `<path d="M1.5 4h4l1.2 1.4H14.5v1.6H1.5z" fill="#3d5bb8" opacity="0.9"/>
   <path d="M1.5 7l1.4 5.75a1 1 0 0 0 .97.75H14.2a1 1 0 0 0 .97-1.25L14.5 7z" fill="#5b8def"/>`,
);

function fileWithChip(chip: string): string {
  return svg(
    `<rect x="3" y="1.75" width="10" height="12.5" rx="1.5" fill="#2a3040" stroke="#4a5268" stroke-width="1"/>
     <path d="M9.5 1.75v3h3" stroke="#4a5268" stroke-width="1"/>
     <rect x="8.5" y="9.5" width="3.2" height="3.2" rx="0.6" fill="${chip}"/>`,
  );
}

export const DUOTONE_FILE = fileWithChip('#6b738a');
export const DUOTONE_TS = fileWithChip('#3178c6');
export const DUOTONE_JS = fileWithChip('#c9a227');
export const DUOTONE_JSON = fileWithChip('#c4a574');
export const DUOTONE_MD = fileWithChip('#8b9bb4');
export const DUOTONE_PY = fileWithChip('#4b8bbe');
export const DUOTONE_RS = fileWithChip('#dea584');
export const DUOTONE_GO = fileWithChip('#29beb0');
export const DUOTONE_CSS = fileWithChip('#563d7c');
export const DUOTONE_HTML = fileWithChip('#e34c26');
export const DUOTONE_YAML = fileWithChip('#cb171e');
export const DUOTONE_TOML = fileWithChip('#9c4221');
export const DUOTONE_LOCK = fileWithChip('#a78bfa');
export const DUOTONE_GIT = fileWithChip('#f05033');
export const DUOTONE_ENV = fileWithChip('#ecd53f');
export const DUOTONE_IMAGE = fileWithChip('#3fb950');
export const DUOTONE_README = fileWithChip('#42a5f5');
