// <FileIcon> — the sole React component in Phase 9.
//
// Resolves a theme-derived icon for an Entry and renders either
// inline SVG (theme-supplied, assumed sanitized) or an <img> tag
// pointing at an external asset URL.
//
// `appearance: 'auto'` watches `prefers-color-scheme` via
// `useSyncExternalStore` so the component re-renders when the
// user toggles system theme.

import {
  memo,
  useMemo,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from 'react';
import type { Entry } from '@vibecook/mille';
import { defaultIconTheme } from './default-theme.js';
import { createIconResolver } from './resolver.js';
import type { IconResolver, IconTheme } from './types.js';

export interface FileIconProps {
  readonly entry: Pick<Entry, 'name' | 'kind'> & { readonly languageId?: string };
  readonly theme?: IconTheme;
  readonly appearance?: 'light' | 'dark' | 'auto';
  readonly expanded?: boolean;
  readonly rootLevel?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
  /** Optional override for the a11y text; defaults to entry.name. */
  readonly ariaLabel?: string;
}

// ─── prefers-color-scheme subscription (SSR-safe) ──────────────────

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeColorScheme(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mql = window.matchMedia(DARK_QUERY);
  // Prefer modern addEventListener; fall back to addListener on older
  // engines (we still want Safari 13 to work in Electron 29+).
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', callback);
    return () => mql.removeEventListener('change', callback);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacy = mql as unknown as { addListener: (cb: () => void) => void; removeListener: (cb: () => void) => void };
  legacy.addListener(callback);
  return () => legacy.removeListener(callback);
}

function getColorScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function getServerColorScheme(): 'light' | 'dark' {
  return 'light';
}

function usePrefersColorScheme(): 'light' | 'dark' {
  return useSyncExternalStore(
    subscribeColorScheme,
    getColorScheme,
    getServerColorScheme,
  );
}

// ─── Component ─────────────────────────────────────────────────────

// Module-level resolver cache, keyed by (theme identity, appearance).
// Ensures `createIconResolver`'s memoization carries across component
// instances when the same theme is used in many rows.
const resolverCache = new WeakMap<IconTheme, { light?: IconResolver; dark?: IconResolver }>();
function getCachedResolver(theme: IconTheme, appearance: 'light' | 'dark'): IconResolver {
  let slot = resolverCache.get(theme);
  if (!slot) {
    slot = {};
    resolverCache.set(theme, slot);
  }
  const existing = slot[appearance];
  if (existing) return existing;
  const fresh = createIconResolver(theme, appearance);
  slot[appearance] = fresh;
  return fresh;
}

function FileIconImpl(props: FileIconProps): ReactElement | null {
  const {
    entry,
    theme = defaultIconTheme,
    appearance = 'auto',
    expanded,
    rootLevel,
    className,
    style,
    ariaLabel,
  } = props;

  const systemPref = usePrefersColorScheme();
  const effectiveAppearance: 'light' | 'dark' =
    appearance === 'auto' ? systemPref : appearance;

  const resolver = useMemo(
    () => getCachedResolver(theme, effectiveAppearance),
    [theme, effectiveAppearance],
  );

  const resolved = useMemo(() => {
    const opts: { expanded?: boolean; rootLevel?: boolean } = {};
    if (expanded !== undefined) opts.expanded = expanded;
    if (rootLevel !== undefined) opts.rootLevel = rootLevel;
    return resolver(entry, opts);
  }, [resolver, entry, expanded, rootLevel]);

  const label = ariaLabel ?? entry.name;

  if (!resolved) return null;

  if (resolved.inlineSvg) {
    // Inline-SVG path: mount the SVG string as HTML. The default
    // theme's SVGs are authored-safe; loader-sourced SVGs should be
    // sanitized via sanitizeSvg() before being stored in the
    // definition's inlineSvg field.
    const spanStyle: CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '1em',
      height: '1em',
      color: resolved.fontColor ?? 'currentColor',
      ...style,
    };
    return (
      <span
        className={className}
        style={spanStyle}
        role="img"
        aria-label={label}
        // React needs `dangerouslySetInnerHTML` for raw SVG markup.
        // The inline SVG here is either (a) authored by us (default
        // theme) or (b) already sanitized at load time.
        dangerouslySetInnerHTML={{ __html: resolved.inlineSvg }}
      />
    );
  }

  if (resolved.assetUrl) {
    const imgStyle: CSSProperties = {
      display: 'inline-block',
      width: '1em',
      height: '1em',
      ...style,
    };
    return (
      <img
        src={resolved.assetUrl}
        alt={label}
        className={className}
        style={imgStyle}
        draggable={false}
      />
    );
  }

  return null;
}

/**
 * Memoized icon component. Re-renders only when identifying props or
 * the color-scheme change; for large trees this keeps per-row icon
 * render cost at one render per unique (theme, appearance, entry) tuple.
 */
export const FileIcon = memo(FileIconImpl);
FileIcon.displayName = 'FileIcon';
