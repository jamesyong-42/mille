// Per-entry icon resolver with VS Code precedence order.
//
// Precedence (files, first winning match is used):
//   1. fileNames[name.toLowerCase()]      — exact file name
//   2. languageIds[entry.languageId]      — only if populated by the engine
//   3. fileExtensions[longestExtMatch]    — longest-compound-ext first
//   4. file                               — theme default
//
// Precedence (folders):
//   rootFolderExpanded → folderExpanded → folder           (expanded+root)
//   folderExpanded     → folder                             (expanded)
//   rootFolder         → folder                             (rootLevel)
//   folder                                                  (default)
//
// The resolver memoizes per unique (name.toLowerCase(), kind, languageId)
// triple; memoization lifetime is tied to the resolver instance, which is
// itself per-(theme, appearance) pair.

import {
  ENTRY_KIND_DIRECTORY,
  type IconDefinition,
  type IconResolver,
  type IconResolverOptions,
  type IconTheme,
  type IconThemeTokens,
  type ResolvedIcon,
} from './types.js';

function pickTokens(
  theme: IconTheme,
  appearance: 'light' | 'dark',
): IconThemeTokens {
  const variant = appearance === 'dark' ? theme.dark : theme.light;
  if (!variant) {
    // Theme is "light-only"; return the root tokens.
    return theme;
  }
  // "Split" theme: merge root defaults with variant overrides. Variant
  // wins on every field; iconDefinitions unions (variant overrides root
  // on collision).
  const mergedDefs: Record<string, IconDefinition> = { ...theme.iconDefinitions };
  for (const [k, v] of Object.entries(variant.iconDefinitions)) {
    mergedDefs[k] = v;
  }
  const merged: Record<string, unknown> = { iconDefinitions: mergedDefs };
  for (const key of [
    'fileExtensions',
    'fileNames',
    'languageIds',
    'folderNames',
    'folderNamesExpanded',
    'file',
    'folder',
    'folderExpanded',
    'rootFolder',
    'rootFolderExpanded',
    'hidesExplorerArrows',
  ] as const) {
    const variantVal = (variant as unknown as Record<string, unknown>)[key];
    const rootVal = (theme as unknown as Record<string, unknown>)[key];
    if (variantVal !== undefined) merged[key] = variantVal;
    else if (rootVal !== undefined) merged[key] = rootVal;
  }
  return merged as unknown as IconThemeTokens;
}

/**
 * Extract candidate extensions from a file name, longest first. For
 * `foo.test.ts`, yields `test.ts`, then `ts`. For `README`, yields
 * nothing. Leading-dot files like `.env` yield `env` (treated as a
 * one-part extension). Case-normalized by the caller.
 */
function candidateExtensions(nameLower: string): readonly string[] {
  // Strip a single leading dot (dotfiles): `.env` → `env`. After the
  // strip, any remaining dot is an extension separator.
  let s = nameLower;
  if (s.startsWith('.')) s = s.slice(1);
  const dot = s.indexOf('.');
  if (dot === -1) {
    // No internal dot — treat the full remaining string as a possible
    // extension (covers `.env`, `.gitignore`, etc.).
    if (nameLower.startsWith('.') && s.length > 0) {
      return [s];
    }
    return [];
  }
  // Split and yield progressively longer compound extensions.
  // e.g. `foo.test.ts` → parts `test.ts`, `ts`.
  const out: string[] = [];
  let cursor = dot + 1;
  while (cursor > 0 && cursor <= s.length) {
    out.push(s.slice(cursor));
    const next = s.indexOf('.', cursor);
    if (next === -1) break;
    cursor = next + 1;
  }
  // Longest-first (slice from smallest cursor).
  return out;
}

function buildResolved(
  iconId: string,
  def: IconDefinition,
): ResolvedIcon {
  const out: { -readonly [K in keyof ResolvedIcon]: ResolvedIcon[K] } = {
    iconId,
    definition: def,
  };
  if (def.iconPath !== undefined) out.assetUrl = def.iconPath;
  if (def.fontColor !== undefined) out.fontColor = def.fontColor;
  if (def.inlineSvg !== undefined) out.inlineSvg = def.inlineSvg;
  return out;
}

/**
 * Create a resolver bound to a theme+appearance. The returned function
 * is referentially stable and safe to pass as a memo dep.
 */
export function createIconResolver(
  theme: IconTheme,
  appearance: 'light' | 'dark',
): IconResolver {
  const tokens = pickTokens(theme, appearance);

  // Memo: key is `${kindBit}|${nameLower}|${langOrBlank}|${expanded?1:0}${root?1:0}`.
  // Only folders vary by `expanded`/`rootLevel`, so files share the same
  // cache slot regardless of those flags.
  const memo = new Map<string, ResolvedIcon | null>();

  function resolveFile(nameLower: string, languageId?: string): ResolvedIcon | null {
    const fileNames = tokens.fileNames;
    if (fileNames && nameLower in fileNames) {
      const id = fileNames[nameLower]!;
      const def = tokens.iconDefinitions[id];
      if (def) return buildResolved(id, def);
    }

    const languageIds = tokens.languageIds;
    if (languageId && languageIds && languageId in languageIds) {
      const id = languageIds[languageId]!;
      const def = tokens.iconDefinitions[id];
      if (def) return buildResolved(id, def);
    }

    const fileExtensions = tokens.fileExtensions;
    if (fileExtensions) {
      for (const ext of candidateExtensions(nameLower)) {
        if (ext in fileExtensions) {
          const id = fileExtensions[ext]!;
          const def = tokens.iconDefinitions[id];
          if (def) return buildResolved(id, def);
        }
      }
    }

    if (tokens.file) {
      const def = tokens.iconDefinitions[tokens.file];
      if (def) return buildResolved(tokens.file, def);
    }
    return null;
  }

  function resolveFolder(
    nameLower: string,
    expanded: boolean,
    rootLevel: boolean,
  ): ResolvedIcon | null {
    // Named-folder overrides.
    if (expanded && tokens.folderNamesExpanded && nameLower in tokens.folderNamesExpanded) {
      const id = tokens.folderNamesExpanded[nameLower]!;
      const def = tokens.iconDefinitions[id];
      if (def) return buildResolved(id, def);
    }
    if (tokens.folderNames && nameLower in tokens.folderNames) {
      const id = tokens.folderNames[nameLower]!;
      const def = tokens.iconDefinitions[id];
      if (def) return buildResolved(id, def);
    }

    // Default folder icons in precedence.
    const chain: Array<string | undefined> = [];
    if (expanded && rootLevel) {
      chain.push(tokens.rootFolderExpanded, tokens.folderExpanded, tokens.folder);
    } else if (expanded) {
      chain.push(tokens.folderExpanded, tokens.folder);
    } else if (rootLevel) {
      chain.push(tokens.rootFolder, tokens.folder);
    } else {
      chain.push(tokens.folder);
    }
    for (const id of chain) {
      if (!id) continue;
      const def = tokens.iconDefinitions[id];
      if (def) return buildResolved(id, def);
    }
    return null;
  }

  const resolver: IconResolver = (entry, opts?: IconResolverOptions) => {
    const nameLower = entry.name.toLowerCase();
    const isDir = entry.kind === ENTRY_KIND_DIRECTORY;
    const expanded = opts?.expanded === true;
    const rootLevel = opts?.rootLevel === true;
    const key = isDir
      ? `d|${nameLower}||${expanded ? 1 : 0}${rootLevel ? 1 : 0}`
      : `f|${nameLower}|${entry.languageId ?? ''}|00`;

    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    const result = isDir
      ? resolveFolder(nameLower, expanded, rootLevel)
      : resolveFile(nameLower, entry.languageId);
    memo.set(key, result);
    return result;
  };
  return resolver;
}
