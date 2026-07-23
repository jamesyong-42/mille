// Icon theme types for @vibecook/mille-ui.
//
// These types mirror the VS Code File Icon Theme JSON schema
// (https://code.visualstudio.com/api/extension-guides/file-icon-theme)
// and add mille-ui specific resolver types. See MILLE_UI_SPEC.md §3.4
// and §8 for the authoritative design.

import type { Entry } from '@vibecook/mille';

/**
 * One icon definition. Maps to the `iconDefinitions` entry in the VS Code
 * File Icon Theme schema. Either `iconPath` (asset URL / data: URL) or
 * `inlineSvg` (sanitized SVG string) must be populated; `fontColor` is
 * advisory for monochrome glyphs.
 *
 * `iconPath` is resolved against the source theme URL at load time by
 * `loadIconTheme` so consumers get absolute URLs. Inline SVGs are
 * populated only by the default theme path (and custom loaders that
 * opt into eager SVG fetching).
 */
export interface IconDefinition {
  readonly iconPath?: string;
  readonly fontColor?: string;
  readonly fontCharacter?: string;
  readonly fontId?: string;
  readonly fontSize?: string;
  /** mille-ui extension: pre-inlined sanitized SVG source. */
  readonly inlineSvg?: string;
}

/**
 * The per-appearance (light / dark) slice of an icon theme. Exactly
 * matches the VS Code schema when used as the theme root, and also
 * serves as the shape of `light` / `dark` overrides.
 */
export interface IconThemeTokens {
  readonly fileExtensions?: Readonly<Record<string, string>>;
  readonly fileNames?: Readonly<Record<string, string>>;
  readonly languageIds?: Readonly<Record<string, string>>;
  readonly folderNames?: Readonly<Record<string, string>>;
  readonly folderNamesExpanded?: Readonly<Record<string, string>>;
  readonly iconDefinitions: Readonly<Record<string, IconDefinition>>;
  readonly file?: string;
  readonly folder?: string;
  readonly folderExpanded?: string;
  readonly rootFolder?: string;
  readonly rootFolderExpanded?: string;
  readonly hidesExplorerArrows?: boolean;
}

/**
 * A complete icon theme. A theme is either "light-only" (the tokens
 * live at the root, `light`/`dark` are absent) or "split" (the root
 * carries defaults and `light`/`dark` override). Consumers of the
 * resolver never see this distinction directly; they always work
 * against a specific-appearance `IconThemeTokens` slice.
 */
export interface IconTheme extends IconThemeTokens {
  readonly id: string;
  readonly light?: IconThemeTokens;
  readonly dark?: IconThemeTokens;
}

/**
 * Options passed to the resolver for a single lookup. `expanded` and
 * `rootLevel` control folder-icon selection (`folder` vs
 * `folderExpanded` vs `rootFolder` vs `rootFolderExpanded`).
 */
export interface IconResolverOptions {
  readonly expanded?: boolean;
  readonly rootLevel?: boolean;
}

/**
 * Result of an icon resolution. Contains the definition plus a cache
 * of commonly-needed fields hoisted to the top level so the renderer
 * doesn't have to branch on which one survived precedence.
 */
export interface ResolvedIcon {
  /** The icon id from the theme's `iconDefinitions` map. */
  readonly iconId: string;
  readonly definition: IconDefinition;
  /** Absolute URL to the asset, if the definition ships one. */
  readonly assetUrl?: string;
  readonly fontColor?: string;
  /** Inlined, sanitized SVG string, if available. */
  readonly inlineSvg?: string;
}

/** Per-entry resolver function. Returns `null` if no match was found. */
export type IconResolver = (
  entry: Pick<Entry, 'name' | 'kind'> & { readonly languageId?: string },
  opts?: IconResolverOptions,
) => ResolvedIcon | null;

/**
 * Entry kinds that the resolver recognizes. Mirrors the engine's
 * numeric kind enum at bit-0 granularity: kind `1` = directory, every
 * other value = file. (See engine SPEC §4.2.)
 */
export const ENTRY_KIND_DIRECTORY = 1;
export const ENTRY_KIND_UNAVAILABLE = 4;
