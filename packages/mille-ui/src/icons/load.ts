// Async loader for VS Code File Icon Theme JSON files.
//
// Resolves relative `iconPath` entries against the source JSON URL so
// consumers get absolute URLs. SVG sanitization is deferred to first
// render (or first manual sanitize call) so loading a theme doesn't
// block on N fetches.

import { validateIconTheme } from './schema.js';
import type { IconDefinition, IconTheme, IconThemeTokens } from './types.js';

export interface LoadIconThemeOptions {
  /** Absolute or relative URL of the theme JSON. */
  readonly url: string;
  /** Optional fetch override (for tests / custom transport). */
  readonly fetch?: typeof fetch;
  /**
   * Optional override for the resolved base URL used when rewriting
   * relative `iconPath`s. Defaults to the dirname of `url`.
   */
  readonly baseUrl?: string;
  /** Optional override for the resulting `IconTheme.id`. */
  readonly id?: string;
}

function baseUrlOf(url: string): string {
  const u = new URL(url, 'http://mille.local/');
  // Strip the filename portion — we want the directory.
  u.pathname = u.pathname.replace(/[^/]+$/, '');
  return u.toString();
}

function rewriteIconPaths(
  tokens: IconThemeTokens,
  base: string,
): IconThemeTokens {
  const defs: Record<string, IconDefinition> = {};
  for (const [id, def] of Object.entries(tokens.iconDefinitions)) {
    if (def.iconPath !== undefined) {
      const abs = new URL(def.iconPath, base).toString();
      defs[id] = { ...def, iconPath: abs };
    } else {
      defs[id] = def;
    }
  }
  // Clone tokens with new iconDefinitions; keep all other fields.
  const out: Record<string, unknown> = { ...tokens, iconDefinitions: defs };
  return out as unknown as IconThemeTokens;
}

/**
 * Fetch, validate, and return a VS Code File Icon Theme. Relative
 * `iconPath`s in the theme are rewritten to absolute URLs against
 * the theme JSON's base URL (or the caller-supplied `baseUrl`).
 *
 * SVG content is **not** fetched here — the resolver returns
 * `assetUrl`s and the `<FileIcon>` component fetches + sanitizes at
 * render time (or consumers can pre-fetch themselves). This keeps
 * startup fast even for themes with thousands of icons.
 */
export async function loadIconTheme(
  options: LoadIconThemeOptions,
): Promise<IconTheme> {
  const { url } = options;
  const fetchImpl = options.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!fetchImpl) {
    throw new Error(
      'loadIconTheme: no fetch implementation available; pass { fetch } explicitly.',
    );
  }

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(
      `loadIconTheme: fetch failed for ${url}: ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json()) as unknown;
  const validated = validateIconTheme(json);

  const base = options.baseUrl ?? baseUrlOf(url);

  const rewrittenRoot = rewriteIconPaths(validated, base);
  const theme: Record<string, unknown> = {
    ...rewrittenRoot,
    id: options.id ?? validated.id,
  };
  if (validated.light) theme['light'] = rewriteIconPaths(validated.light, base);
  if (validated.dark) theme['dark'] = rewriteIconPaths(validated.dark, base);
  return theme as unknown as IconTheme;
}
