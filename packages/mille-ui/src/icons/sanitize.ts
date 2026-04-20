// Minimal SVG sanitizer for icon theme assets.
//
// Uses the DOM `DOMParser` (available in browsers and via happy-dom
// in tests). Walks the parsed tree, strips disallowed elements and
// attributes, and serializes back. The output is safe to insert via
// React's `dangerouslySetInnerHTML` or (better) as a fresh DOM tree.
//
// Sanitization policy:
//   - Allowlisted elements only; disallowed elements are removed
//     (children are dropped too — they're not hoisted).
//   - Allowlisted attributes only; anything else is removed.
//   - `on*` event handlers → removed (defense in depth; the attr
//     allowlist already excludes them).
//   - `href` / `xlink:href` → allowed only when the value starts
//     with `#` (internal fragment reference, for `<use>`).
//   - <script>, <foreignObject> → always removed.
//   - <style> → removed (could smuggle `@import url(...)`).
//
// No regex-based parsing anywhere. The DOMParser is the parser.

// Tag names are stored lowercase — we match against `nodeName.toLowerCase()`,
// which normalizes across HTML parsers that downcase and XML parsers that
// preserve case.
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'rect',
  'polygon',
  'polyline',
  'line',
  'ellipse',
  'defs',
  'use',
  'symbol',
  'title',
  'desc',
  'lineargradient',
  'radialgradient',
  'stop',
]);

const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  'viewBox',
  'width',
  'height',
  'd',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'cx',
  'cy',
  'r',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'rx',
  'ry',
  'transform',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'id',
  'href',
  'xlink:href',
  'gradientUnits',
  'offset',
  'stop-color',
  'stop-opacity',
  // SVG namespace — allowed on root for validity; not a security risk.
  'xmlns',
  'xmlns:xlink',
  // Additional transform-space attrs benign for icons.
  'gradientTransform',
  'spreadMethod',
  'preserveAspectRatio',
]);

export class SvgSanitizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SvgSanitizationError';
  }
}

/**
 * Sanitize an untrusted SVG source string. Requires a DOM; throws if
 * `DOMParser` is not available in the current environment.
 */
export function sanitizeSvg(svg: string): string {
  if (typeof svg !== 'string') {
    throw new SvgSanitizationError('input must be a string');
  }
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
    throw new SvgSanitizationError(
      'sanitizeSvg requires DOMParser/XMLSerializer — run from a DOM or happy-dom environment, or sanitize at load time.',
    );
  }

  const parser = new DOMParser();

  // Parse strategy: try image/svg+xml first (native browsers honor
  // it and return a <parsererror> on malformed input). If that path
  // leaves us without a document element (happy-dom's image/svg+xml
  // is partial), fall back to text/html and pull the <svg> back out.
  // In both cases we still walk+filter with the same allowlist.
  let root: Element | null = null;

  const xmlDoc = parser.parseFromString(svg, 'image/svg+xml');
  const xmlError = xmlDoc.getElementsByTagName('parsererror');
  if (xmlError.length > 0) {
    throw new SvgSanitizationError('malformed SVG: parser reported an error');
  }
  const xmlRoot = xmlDoc.documentElement;
  if (xmlRoot && xmlRoot.nodeName.toLowerCase() === 'svg') {
    root = xmlRoot;
  }

  if (!root) {
    const htmlDoc = parser.parseFromString(svg, 'text/html');
    // Look for <svg> anywhere in the parsed output (usually body).
    const svgs = htmlDoc.getElementsByTagName('svg');
    if (svgs.length === 0) {
      throw new SvgSanitizationError('input does not appear to be an SVG document');
    }
    root = svgs[0] as Element;
  }

  // Filter attributes on the root element too — a `<svg onload=…>`
  // payload wouldn't be caught by the child-walk otherwise.
  filterAttrs(root);
  walk(root);

  const serializer = new XMLSerializer();
  return serializer.serializeToString(root);
}

function walk(node: Element): void {
  // Snapshot children: we'll remove some during iteration.
  const children = Array.from(node.childNodes);
  for (const child of children) {
    const nodeType = child.nodeType;
    // Element = 1, Text = 3, Comment = 8, CDATA = 4
    if (nodeType === 1) {
      const el = child as Element;
      const tag = el.nodeName.toLowerCase();
      if (!ALLOWED_ELEMENTS.has(tag)) {
        el.parentNode?.removeChild(el);
        continue;
      }
      filterAttrs(el);
      walk(el);
    } else if (nodeType === 8 || nodeType === 4) {
      // Strip comments + CDATA — they're never useful in icon SVGs
      // and could carry smuggled payloads through fuzzy parsers.
      child.parentNode?.removeChild(child);
    }
    // Text nodes kept as-is.
  }
}

function filterAttrs(el: Element): void {
  // Snapshot the attribute list; we'll be mutating during iteration.
  const attrs = Array.from(el.attributes);
  for (const attr of attrs) {
    const name = attr.name;
    const lower = name.toLowerCase();

    // Blanket block on event handlers.
    if (lower.startsWith('on')) {
      el.removeAttribute(name);
      continue;
    }

    if (!ALLOWED_ATTRS.has(name) && !ALLOWED_ATTRS.has(lower)) {
      el.removeAttribute(name);
      continue;
    }

    // Constrain href/xlink:href to internal refs.
    if (lower === 'href' || lower === 'xlink:href') {
      const val = attr.value.trim();
      if (!val.startsWith('#')) {
        el.removeAttribute(name);
      }
      continue;
    }

    // Reject style="..." via url() (we don't even accept `style`, but
    // defense in depth).
    if (lower === 'style') {
      el.removeAttribute(name);
    }
  }
}
