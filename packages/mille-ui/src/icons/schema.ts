// Hand-rolled validator for the VS Code File Icon Theme JSON schema.
// No zod, no ajv — just a structural walk with clear errors.
//
// Accepts two theme shapes:
//   - "light-only" — tokens at the root (no `light`/`dark`).
//   - "split"     — optional `light` and `dark` overrides; the root
//                    still carries defaults (VS Code treats the root
//                    as the fallback when a variant is missing).
//
// Validator keeps unknown fields silently (forward-compat), but
// strictly types the known subset.

import type {
  IconDefinition,
  IconTheme,
  IconThemeTokens,
} from './types.js';

export class IconThemeValidationError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`IconTheme validation failed at "${path}": ${message}`);
    this.name = 'IconThemeValidationError';
    this.path = path;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, path: string): string {
  if (typeof v !== 'string') {
    throw new IconThemeValidationError(`expected string, got ${typeOf(v)}`, path);
  }
  return v;
}

function optionalString(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  return requireString(v, path);
}

function optionalBoolean(v: unknown, path: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') {
    throw new IconThemeValidationError(`expected boolean, got ${typeOf(v)}`, path);
  }
  return v;
}

function validateStringMap(
  v: unknown,
  path: string,
): Readonly<Record<string, string>> | undefined {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) {
    throw new IconThemeValidationError(`expected object, got ${typeOf(v)}`, path);
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') {
      throw new IconThemeValidationError(
        `expected string value, got ${typeOf(val)}`,
        `${path}.${k}`,
      );
    }
    out[k] = val;
  }
  return out;
}

function validateIconDefinition(v: unknown, path: string): IconDefinition {
  if (!isPlainObject(v)) {
    throw new IconThemeValidationError(`expected object, got ${typeOf(v)}`, path);
  }
  const iconPath = optionalString(v['iconPath'], `${path}.iconPath`);
  const fontColor = optionalString(v['fontColor'], `${path}.fontColor`);
  const fontCharacter = optionalString(v['fontCharacter'], `${path}.fontCharacter`);
  const fontId = optionalString(v['fontId'], `${path}.fontId`);
  const fontSize = optionalString(v['fontSize'], `${path}.fontSize`);
  const inlineSvg = optionalString(v['inlineSvg'], `${path}.inlineSvg`);

  if (!iconPath && !fontCharacter && !inlineSvg) {
    throw new IconThemeValidationError(
      'definition must carry at least one of `iconPath`, `fontCharacter`, or `inlineSvg`',
      path,
    );
  }

  const def: Record<string, unknown> = {};
  if (iconPath !== undefined) def['iconPath'] = iconPath;
  if (fontColor !== undefined) def['fontColor'] = fontColor;
  if (fontCharacter !== undefined) def['fontCharacter'] = fontCharacter;
  if (fontId !== undefined) def['fontId'] = fontId;
  if (fontSize !== undefined) def['fontSize'] = fontSize;
  if (inlineSvg !== undefined) def['inlineSvg'] = inlineSvg;
  return def as IconDefinition;
}

function validateIconDefinitions(
  v: unknown,
  path: string,
): Readonly<Record<string, IconDefinition>> {
  if (!isPlainObject(v)) {
    throw new IconThemeValidationError(
      `expected object, got ${typeOf(v)}`,
      path,
    );
  }
  const out: Record<string, IconDefinition> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = validateIconDefinition(val, `${path}.${k}`);
  }
  return out;
}

/**
 * Validate the tokens slice (root OR light OR dark). Returns a
 * freshly-constructed frozen object; never mutates input.
 */
function validateTokens(v: Record<string, unknown>, path: string): IconThemeTokens {
  const iconDefinitions = validateIconDefinitions(
    v['iconDefinitions'],
    `${path}.iconDefinitions`,
  );
  const fileExtensions = validateStringMap(v['fileExtensions'], `${path}.fileExtensions`);
  const fileNames = validateStringMap(v['fileNames'], `${path}.fileNames`);
  const languageIds = validateStringMap(v['languageIds'], `${path}.languageIds`);
  const folderNames = validateStringMap(v['folderNames'], `${path}.folderNames`);
  const folderNamesExpanded = validateStringMap(
    v['folderNamesExpanded'],
    `${path}.folderNamesExpanded`,
  );

  const file = optionalString(v['file'], `${path}.file`);
  const folder = optionalString(v['folder'], `${path}.folder`);
  const folderExpanded = optionalString(v['folderExpanded'], `${path}.folderExpanded`);
  const rootFolder = optionalString(v['rootFolder'], `${path}.rootFolder`);
  const rootFolderExpanded = optionalString(
    v['rootFolderExpanded'],
    `${path}.rootFolderExpanded`,
  );
  const hidesExplorerArrows = optionalBoolean(
    v['hidesExplorerArrows'],
    `${path}.hidesExplorerArrows`,
  );

  // Verify referenced ids exist in iconDefinitions.
  const refs: Array<[string, string | undefined]> = [
    [`${path}.file`, file],
    [`${path}.folder`, folder],
    [`${path}.folderExpanded`, folderExpanded],
    [`${path}.rootFolder`, rootFolder],
    [`${path}.rootFolderExpanded`, rootFolderExpanded],
  ];
  for (const [refPath, id] of refs) {
    if (id !== undefined && !(id in iconDefinitions)) {
      throw new IconThemeValidationError(
        `id "${id}" is not present in iconDefinitions`,
        refPath,
      );
    }
  }
  for (const [mapName, map] of [
    ['fileExtensions', fileExtensions] as const,
    ['fileNames', fileNames] as const,
    ['languageIds', languageIds] as const,
    ['folderNames', folderNames] as const,
    ['folderNamesExpanded', folderNamesExpanded] as const,
  ]) {
    if (!map) continue;
    for (const [k, id] of Object.entries(map)) {
      if (!(id in iconDefinitions)) {
        throw new IconThemeValidationError(
          `id "${id}" is not present in iconDefinitions`,
          `${path}.${mapName}.${k}`,
        );
      }
    }
  }

  const tokens: Record<string, unknown> = { iconDefinitions };
  if (fileExtensions) tokens['fileExtensions'] = fileExtensions;
  if (fileNames) tokens['fileNames'] = fileNames;
  if (languageIds) tokens['languageIds'] = languageIds;
  if (folderNames) tokens['folderNames'] = folderNames;
  if (folderNamesExpanded) tokens['folderNamesExpanded'] = folderNamesExpanded;
  if (file !== undefined) tokens['file'] = file;
  if (folder !== undefined) tokens['folder'] = folder;
  if (folderExpanded !== undefined) tokens['folderExpanded'] = folderExpanded;
  if (rootFolder !== undefined) tokens['rootFolder'] = rootFolder;
  if (rootFolderExpanded !== undefined) tokens['rootFolderExpanded'] = rootFolderExpanded;
  if (hidesExplorerArrows !== undefined) {
    tokens['hidesExplorerArrows'] = hidesExplorerArrows;
  }
  return tokens as unknown as IconThemeTokens;
}

/**
 * Validate a JSON value parsed from a VS Code File Icon Theme JSON.
 * Throws `IconThemeValidationError` with a path on the first problem.
 * On success, returns a structurally-correct `IconTheme`.
 *
 * The input `id` is optional in raw VS Code theme JSON; if absent,
 * a placeholder `'<unnamed>'` is used. Consumers loading themes via
 * `loadIconTheme` pass an `id` option that overrides.
 */
export function validateIconTheme(json: unknown): IconTheme {
  if (!isPlainObject(json)) {
    throw new IconThemeValidationError(
      `expected object at root, got ${typeOf(json)}`,
      '$',
    );
  }

  const lightRaw = json['light'];
  const darkRaw = json['dark'];
  const hasSplit = lightRaw !== undefined || darkRaw !== undefined;

  // Root-level tokens. If the theme is "split" AND the root lacks an
  // `iconDefinitions`, synthesize an empty one so consumers can still
  // rely on root defaults merging predictably.
  let rootTokens: IconThemeTokens;
  if (!hasSplit) {
    rootTokens = validateTokens(json, '$');
  } else if ('iconDefinitions' in json) {
    rootTokens = validateTokens(json, '$');
  } else {
    rootTokens = { iconDefinitions: {} };
  }

  let light: IconThemeTokens | undefined;
  if (lightRaw !== undefined) {
    if (!isPlainObject(lightRaw)) {
      throw new IconThemeValidationError(
        `expected object, got ${typeOf(lightRaw)}`,
        '$.light',
      );
    }
    // Light/dark slices MAY have their own iconDefinitions or reuse root's.
    // If they lack iconDefinitions entirely, validate with an empty stub.
    const lightObj: Record<string, unknown> = {
      iconDefinitions: lightRaw['iconDefinitions'] ?? rootTokens.iconDefinitions,
      ...lightRaw,
    };
    light = validateTokens(lightObj, '$.light');
  }

  let dark: IconThemeTokens | undefined;
  if (darkRaw !== undefined) {
    if (!isPlainObject(darkRaw)) {
      throw new IconThemeValidationError(
        `expected object, got ${typeOf(darkRaw)}`,
        '$.dark',
      );
    }
    const darkObj: Record<string, unknown> = {
      iconDefinitions: darkRaw['iconDefinitions'] ?? rootTokens.iconDefinitions,
      ...darkRaw,
    };
    dark = validateTokens(darkObj, '$.dark');
  }

  const idRaw = json['id'];
  const id =
    typeof idRaw === 'string' && idRaw.length > 0 ? idRaw : '<unnamed>';

  const theme: Record<string, unknown> = { id, ...rootTokens };
  if (light) theme['light'] = light;
  if (dark) theme['dark'] = dark;
  return theme as unknown as IconTheme;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
