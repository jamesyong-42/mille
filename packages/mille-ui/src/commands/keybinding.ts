// Keybinding string parser, matcher, and formatter.
//
// Grammar: `[<Mod>+]*<Key>` with modifiers separated by `+`. Modifiers:
//   - `Mod`   → Cmd on macOS, Ctrl elsewhere (VS Code convention)
//   - `Cmd`   → Cmd/Meta (explicit)
//   - `Ctrl`  → Control (explicit, always)
//   - `Alt`   → Alt / Option
//   - `Shift` → Shift
//
// Keys are matched against `KeyboardEvent.key`. Common aliases supported:
//   - Letters (`a`-`z`) normalized uppercase
//   - `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`
//   - `F1`..`F24`
//   - `Delete`, `Backspace`, `Enter`, `Escape`, `Tab`, `Space`
//   - Punctuation as typed (`+` when alone, otherwise separated)

export interface ParsedKeybinding {
  readonly cmd: boolean;   // macOS ⌘ / Windows/Linux ❌
  readonly ctrl: boolean;  // always Control
  readonly alt: boolean;
  readonly shift: boolean;
  readonly key: string;    // normalized
}

/** Detect macOS in a Node- and browser-safe way. */
function isMac(): boolean {
  if (typeof navigator !== 'undefined' && typeof navigator.platform === 'string') {
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  }
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    return process.platform === 'darwin';
  }
  return false;
}

/**
 * Normalize a user-provided key token to the canonical form we compare
 * against `KeyboardEvent.key`. Case-insensitive for single-letter inputs;
 * pass-through for named keys.
 */
function normalizeKey(token: string): string {
  if (token.length === 1) {
    // Letters canonicalized uppercase; digits/punctuation unchanged.
    return /^[a-z]$/i.test(token) ? token.toUpperCase() : token;
  }
  const lower = token.toLowerCase();
  switch (lower) {
    case 'up': return 'ArrowUp';
    case 'down': return 'ArrowDown';
    case 'left': return 'ArrowLeft';
    case 'right': return 'ArrowRight';
    case 'esc': return 'Escape';
    case 'escape': return 'Escape';
    case 'enter': return 'Enter';
    case 'return': return 'Enter';
    case 'tab': return 'Tab';
    case 'space': return ' ';
    case 'spacebar': return ' ';
    case 'del': return 'Delete';
    case 'delete': return 'Delete';
    case 'backspace': return 'Backspace';
    case 'home': return 'Home';
    case 'end': return 'End';
    case 'pageup': return 'PageUp';
    case 'pagedown': return 'PageDown';
    case 'arrowup': return 'ArrowUp';
    case 'arrowdown': return 'ArrowDown';
    case 'arrowleft': return 'ArrowLeft';
    case 'arrowright': return 'ArrowRight';
    default:
      // F-keys
      if (/^f(\d{1,2})$/i.test(token)) {
        const n = Number(token.slice(1));
        return `F${n}`;
      }
      return token;
  }
}

/**
 * Parse a keybinding string like `Mod+Shift+F2` into modifier flags + key.
 * Throws on empty input or on trailing/leading `+`.
 */
export function parseKeybinding(str: string): ParsedKeybinding {
  if (typeof str !== 'string' || str.length === 0) {
    throw new Error('parseKeybinding: empty keybinding string');
  }
  // Handle a literal `+` as the key (tokenize but don't split on leading/trailing +).
  const raw = str.trim();
  // Support the corner case of `+` being used as a key (e.g. `Mod++`). We
  // split on `+` but allow a trailing empty token to mean literal `+`.
  const parts = raw.split('+');
  if (parts.length === 0) {
    throw new Error(`parseKeybinding: invalid keybinding "${str}"`);
  }
  let cmd = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let keyToken: string | null = null;
  const mac = isMac();

  // If the last token is empty string, the user wrote `...+` meaning literal `+`.
  // Reconstruct: the key is `+` and the modifiers are parts[0..-2].
  const lastEmpty = parts.length >= 2 && parts[parts.length - 1] === '';
  const tokens = lastEmpty ? parts.slice(0, -1) : parts;
  if (lastEmpty) keyToken = '+';

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined || tok === '') {
      throw new Error(`parseKeybinding: malformed keybinding "${str}"`);
    }
    const lower = tok.toLowerCase();
    const isLast = i === tokens.length - 1;
    if (!isLast || keyToken !== null) {
      // Must be a modifier.
      switch (lower) {
        case 'mod':
          if (mac) cmd = true; else ctrl = true;
          break;
        case 'cmd':
        case 'meta':
        case 'super':
          cmd = true;
          break;
        case 'ctrl':
        case 'control':
          ctrl = true;
          break;
        case 'alt':
        case 'option':
        case 'opt':
          alt = true;
          break;
        case 'shift':
          shift = true;
          break;
        default:
          throw new Error(`parseKeybinding: unknown modifier "${tok}" in "${str}"`);
      }
    } else {
      keyToken = tok;
    }
  }

  if (keyToken === null) {
    throw new Error(`parseKeybinding: missing key in "${str}"`);
  }

  return {
    cmd,
    ctrl,
    alt,
    shift,
    key: normalizeKey(keyToken),
  };
}

/**
 * Minimal subset of `KeyboardEvent` used for matching. Lets tests pass plain
 * objects without instantiating a real `KeyboardEvent`.
 */
export interface KeyboardEventLike {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

/** Does this event match the parsed binding? */
export function matchKeybinding(
  event: KeyboardEventLike,
  parsed: ParsedKeybinding,
): boolean {
  const evCmd = Boolean(event.metaKey);
  const evCtrl = Boolean(event.ctrlKey);
  const evAlt = Boolean(event.altKey);
  const evShift = Boolean(event.shiftKey);
  if (evCmd !== parsed.cmd) return false;
  if (evCtrl !== parsed.ctrl) return false;
  if (evAlt !== parsed.alt) return false;
  if (evShift !== parsed.shift) return false;

  // Case-insensitive letter match to absorb shift-derived case differences.
  const evKey = event.key;
  if (parsed.key.length === 1 && evKey.length === 1) {
    return parsed.key.toUpperCase() === evKey.toUpperCase();
  }
  return parsed.key === evKey;
}

/** Human-facing display form (e.g. `⌘⇧F2` on macOS, `Ctrl+Shift+F2` elsewhere). */
export function formatKeybinding(parsed: ParsedKeybinding): string {
  const mac = isMac();
  const parts: string[] = [];
  if (mac) {
    if (parsed.ctrl) parts.push('⌃');
    if (parsed.alt) parts.push('⌥');
    if (parsed.shift) parts.push('⇧');
    if (parsed.cmd) parts.push('⌘');
    parts.push(formatKeyToken(parsed.key));
    return parts.join('');
  }
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.cmd) parts.push('Meta');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  parts.push(formatKeyToken(parsed.key));
  return parts.join('+');
}

function formatKeyToken(key: string): string {
  if (key === ' ') return 'Space';
  if (key === 'ArrowUp') return '↑';
  if (key === 'ArrowDown') return '↓';
  if (key === 'ArrowLeft') return '←';
  if (key === 'ArrowRight') return '→';
  return key;
}
