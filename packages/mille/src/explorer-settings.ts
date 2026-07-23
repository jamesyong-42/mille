export const EXPLORER_SETTINGS_VERSION = 1 as const;

export const EXPLORER_SETTINGS_LIMITS = Object.freeze({
  workspaces: 128,
  rootsPerWorkspace: 64,
  excludeGlobs: 256,
  nestingPatterns: 256,
  nestingChildren: 64,
  stringLength: 1_024,
});

export type ExplorerSortBy = 'name' | 'type' | 'modified';

export interface ResolvedExplorerSettings {
  readonly sortBy: ExplorerSortBy;
  readonly caseSensitive: boolean;
  readonly locale: string | null;
  readonly foldersOnTop: boolean;
  readonly showHiddenFiles: boolean;
  readonly showIgnoredFiles: boolean;
  readonly compactFolders: boolean;
  readonly excludeGlobs: readonly string[];
  /**
   * Parent pattern → exact companion-name templates. Parent patterns accept
   * zero or one `*`; child templates may substitute `${capture}`.
   */
  readonly fileNestingPatterns: Readonly<Record<string, readonly string[]>>;
}

export type ExplorerProjectionSettings = Pick<
  ResolvedExplorerSettings,
  | 'sortBy'
  | 'caseSensitive'
  | 'foldersOnTop'
  | 'showHiddenFiles'
  | 'showIgnoredFiles'
  | 'compactFolders'
  | 'fileNestingPatterns'
>;

export type ExplorerSettingsOverride = Partial<ResolvedExplorerSettings>;

export interface ExplorerWorkspaceSettings {
  readonly settings?: ExplorerSettingsOverride;
  readonly roots?: Readonly<Record<string, ExplorerSettingsOverride>>;
}

export interface ExplorerSettingsDocument {
  readonly version: typeof EXPLORER_SETTINGS_VERSION;
  readonly global?: ExplorerSettingsOverride;
  readonly workspaces?: Readonly<Record<string, ExplorerWorkspaceSettings>>;
}

export const DEFAULT_EXPLORER_SETTINGS: ResolvedExplorerSettings = Object.freeze({
  sortBy: 'name',
  caseSensitive: false,
  locale: null,
  foldersOnTop: true,
  showHiddenFiles: true,
  showIgnoredFiles: true,
  compactFolders: true,
  excludeGlobs: Object.freeze([]),
  fileNestingPatterns: Object.freeze({}),
});
const normalizedDocuments = new WeakSet<object>();

function validString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= EXPLORER_SETTINGS_LIMITS.stringLength &&
    !value.includes('\0')
  );
}

function stringArray(value: unknown, limit: number): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = new Set<string>();
  for (const item of value) {
    if (validString(item)) out.add(item);
    if (out.size >= limit) break;
  }
  return Object.freeze([...out].sort());
}

function nestingPatterns(value: unknown): Readonly<Record<string, readonly string[]>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, readonly string[]> = {};
  for (const key of Object.keys(value).sort()) {
    if (!validString(key) || Object.keys(out).length >= EXPLORER_SETTINGS_LIMITS.nestingPatterns) {
      continue;
    }
    const children = stringArray(
      (value as Record<string, unknown>)[key],
      EXPLORER_SETTINGS_LIMITS.nestingChildren,
    );
    if (children !== undefined) out[key] = children;
  }
  return Object.freeze(out);
}

function override(value: unknown): ExplorerSettingsOverride | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const out: {
    -readonly [Key in keyof ResolvedExplorerSettings]?: ResolvedExplorerSettings[Key];
  } = {};
  if (record.sortBy === 'name' || record.sortBy === 'type' || record.sortBy === 'modified') {
    out.sortBy = record.sortBy;
  }
  for (const key of [
    'caseSensitive',
    'foldersOnTop',
    'showHiddenFiles',
    'showIgnoredFiles',
    'compactFolders',
  ] as const) {
    if (typeof record[key] === 'boolean') out[key] = record[key];
  }
  if (record.locale === null) out.locale = null;
  else if (validString(record.locale) && record.locale.length <= 64) out.locale = record.locale;
  const excludes = stringArray(record.excludeGlobs, EXPLORER_SETTINGS_LIMITS.excludeGlobs);
  if (excludes !== undefined) out.excludeGlobs = excludes;
  const patterns = nestingPatterns(record.fileNestingPatterns);
  if (patterns !== undefined) out.fileNestingPatterns = patterns;
  return Object.freeze(out);
}

function workspace(value: unknown): ExplorerWorkspaceSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const settings = override(record.settings);
  const roots: Record<string, ExplorerSettingsOverride> = {};
  if (typeof record.roots === 'object' && record.roots !== null && !Array.isArray(record.roots)) {
    for (const key of Object.keys(record.roots).sort()) {
      if (
        !validString(key) ||
        Object.keys(roots).length >= EXPLORER_SETTINGS_LIMITS.rootsPerWorkspace
      ) {
        continue;
      }
      const parsed = override((record.roots as Record<string, unknown>)[key]);
      if (parsed !== undefined) roots[key] = parsed;
    }
  }
  return Object.freeze({
    ...(settings !== undefined ? { settings } : {}),
    ...(Object.keys(roots).length > 0 ? { roots: Object.freeze(roots) } : {}),
  });
}

export function parseExplorerSettings(input: string | unknown): ExplorerSettingsDocument | null {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 0 && record.version !== 1) return null;

  // Pre-release v0 was a flat override. A v1-shaped record may omit version
  // while a host is constructing it, so `global`/`workspaces` still win.
  const global = override(
    record.global ??
      (record.version === undefined && record.workspaces === undefined ? record : undefined),
  );
  const workspaces: Record<string, ExplorerWorkspaceSettings> = {};
  if (
    typeof record.workspaces === 'object' &&
    record.workspaces !== null &&
    !Array.isArray(record.workspaces)
  ) {
    for (const key of Object.keys(record.workspaces).sort()) {
      if (
        !validString(key) ||
        Object.keys(workspaces).length >= EXPLORER_SETTINGS_LIMITS.workspaces
      ) {
        continue;
      }
      const parsed = workspace((record.workspaces as Record<string, unknown>)[key]);
      if (parsed !== undefined) workspaces[key] = parsed;
    }
  }
  const parsed = Object.freeze({
    version: EXPLORER_SETTINGS_VERSION,
    ...(global !== undefined ? { global } : {}),
    ...(Object.keys(workspaces).length > 0 ? { workspaces: Object.freeze(workspaces) } : {}),
  });
  normalizedDocuments.add(parsed);
  return parsed;
}

export function serializeExplorerSettings(settings: ExplorerSettingsDocument): string {
  const parsed = parseExplorerSettings(settings);
  if (parsed === null) throw new TypeError('Invalid explorer settings');
  return JSON.stringify(parsed);
}

function merge(
  base: ResolvedExplorerSettings,
  next: ExplorerSettingsOverride | undefined,
): ResolvedExplorerSettings {
  if (next === undefined) return base;
  return Object.freeze({
    ...base,
    ...next,
    excludeGlobs: next.excludeGlobs ?? base.excludeGlobs,
    fileNestingPatterns: Object.freeze({
      ...base.fileNestingPatterns,
      ...(next.fileNestingPatterns ?? {}),
    }),
  });
}

export function resolveExplorerSettings(
  document: ExplorerSettingsDocument | null | undefined,
  workspaceKey?: string,
  rootKey?: string,
): ResolvedExplorerSettings {
  if (document === null || document === undefined) return DEFAULT_EXPLORER_SETTINGS;
  const parsed = normalizedDocuments.has(document as object)
    ? document
    : parseExplorerSettings(document);
  if (parsed === null) return DEFAULT_EXPLORER_SETTINGS;
  let resolved = merge(DEFAULT_EXPLORER_SETTINGS, parsed.global);
  const selected = workspaceKey === undefined ? undefined : parsed.workspaces?.[workspaceKey];
  resolved = merge(resolved, selected?.settings);
  if (rootKey !== undefined) resolved = merge(resolved, selected?.roots?.[rootKey]);
  return resolved;
}
