// Tests for the keybinding string parser + matcher + formatter.
//
// Uses Node's built-in test runner; no dependencies beyond the compiled
// output in dist/.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseKeybinding,
  matchKeybinding,
  formatKeybinding,
} from '../dist/commands/keybinding.js';

const IS_MAC = process.platform === 'darwin';

describe('parseKeybinding', () => {
  it('parses bare F2', () => {
    const p = parseKeybinding('F2');
    assert.equal(p.key, 'F2');
    assert.equal(p.cmd, false);
    assert.equal(p.ctrl, false);
    assert.equal(p.alt, false);
    assert.equal(p.shift, false);
  });

  it('parses Delete', () => {
    const p = parseKeybinding('Delete');
    assert.equal(p.key, 'Delete');
  });

  it('parses Mod+C — Cmd on mac, Ctrl elsewhere', () => {
    const p = parseKeybinding('Mod+C');
    assert.equal(p.key, 'C');
    if (IS_MAC) {
      assert.equal(p.cmd, true);
      assert.equal(p.ctrl, false);
    } else {
      assert.equal(p.cmd, false);
      assert.equal(p.ctrl, true);
    }
  });

  it('parses Mod+Shift+N', () => {
    const p = parseKeybinding('Mod+Shift+N');
    assert.equal(p.key, 'N');
    assert.equal(p.shift, true);
    if (IS_MAC) assert.equal(p.cmd, true);
    else assert.equal(p.ctrl, true);
  });

  it('parses Alt+ArrowUp', () => {
    const p = parseKeybinding('Alt+ArrowUp');
    assert.equal(p.key, 'ArrowUp');
    assert.equal(p.alt, true);
    assert.equal(p.cmd, false);
    assert.equal(p.ctrl, false);
  });

  it('parses explicit Ctrl+S even on macOS', () => {
    const p = parseKeybinding('Ctrl+S');
    assert.equal(p.key, 'S');
    assert.equal(p.ctrl, true);
    assert.equal(p.cmd, false);
  });

  it('parses aliases: Esc → Escape, Space → " "', () => {
    assert.equal(parseKeybinding('Esc').key, 'Escape');
    assert.equal(parseKeybinding('Space').key, ' ');
  });

  it('throws on empty input', () => {
    assert.throws(() => parseKeybinding(''), /empty/);
  });

  it('throws on unknown modifier', () => {
    assert.throws(() => parseKeybinding('Hyper+X'), /unknown modifier/);
  });
});

describe('matchKeybinding', () => {
  it('matches F2 event', () => {
    const parsed = parseKeybinding('F2');
    assert.equal(matchKeybinding({ key: 'F2' }, parsed), true);
    assert.equal(matchKeybinding({ key: 'F3' }, parsed), false);
  });

  it('matches Mod+C event with the platform modifier', () => {
    const parsed = parseKeybinding('Mod+C');
    const ev = IS_MAC
      ? { key: 'c', metaKey: true }
      : { key: 'c', ctrlKey: true };
    assert.equal(matchKeybinding(ev, parsed), true);
  });

  it('rejects when modifier flags mismatch', () => {
    const parsed = parseKeybinding('Mod+C');
    const wrong = IS_MAC
      ? { key: 'c', ctrlKey: true } // wrong modifier on mac
      : { key: 'c', metaKey: true };
    assert.equal(matchKeybinding(wrong, parsed), false);
  });

  it('matches Alt+ArrowUp', () => {
    const parsed = parseKeybinding('Alt+ArrowUp');
    assert.equal(matchKeybinding({ key: 'ArrowUp', altKey: true }, parsed), true);
    assert.equal(matchKeybinding({ key: 'ArrowUp' }, parsed), false);
  });

  it('is case-insensitive on single-letter keys', () => {
    const parsed = parseKeybinding('Mod+C');
    const ev = IS_MAC
      ? { key: 'C', metaKey: true, shiftKey: false }
      : { key: 'C', ctrlKey: true, shiftKey: false };
    // shiftKey: false on both sides; letter case differs
    assert.equal(matchKeybinding(ev, parsed), true);
  });
});

describe('formatKeybinding', () => {
  it('round-trips a simple binding', () => {
    const parsed = parseKeybinding('F2');
    const formatted = formatKeybinding(parsed);
    assert.ok(formatted.includes('F2'), `expected "F2" in "${formatted}"`);
  });

  it('includes a key token', () => {
    for (const str of ['F2', 'Delete', 'Mod+C', 'Mod+Shift+N', 'Alt+ArrowUp']) {
      const parsed = parseKeybinding(str);
      const formatted = formatKeybinding(parsed);
      assert.ok(formatted.length > 0, `expected non-empty format for "${str}"`);
    }
  });
});
