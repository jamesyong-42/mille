// Phase 9.3 — SVG sanitizer tests.
//
// Uses happy-dom's DOMParser + XMLSerializer (installed as a devDep
// of @vibecook/mille-ui). Installs them globally for the duration of
// the test, mimicking how the library is used inside a renderer.

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { Window } from 'happy-dom';

let win;

before(() => {
  win = new Window();
  globalThis.DOMParser = win.DOMParser;
  globalThis.XMLSerializer = win.XMLSerializer;
  globalThis.Element = win.Element;
});

after(async () => {
  delete globalThis.DOMParser;
  delete globalThis.XMLSerializer;
  delete globalThis.Element;
  await win.happyDOM.close();
});

const { sanitizeSvg, SvgSanitizationError } = await import(
  '../dist/icons/sanitize.js'
);

test('sanitize: round-trips a well-formed minimal SVG', () => {
  const input =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1h14v14H1z" fill="currentColor"/></svg>';
  const out = sanitizeSvg(input);
  assert.match(out, /<svg[\s\S]*viewBox="0 0 16 16"/);
  assert.match(out, /<path[\s\S]*d="M1 1h14v14H1z"/);
  assert.match(out, /fill="currentColor"/);
});

test('sanitize: strips <script> elements', () => {
  const input =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><path d="M0 0"/></svg>';
  const out = sanitizeSvg(input);
  assert.ok(!/script/i.test(out), `output should not contain a <script>: ${out}`);
  assert.match(out, /<path/);
});

test('sanitize: strips <foreignObject>', () => {
  const input =
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>pwn</div></foreignObject></svg>';
  const out = sanitizeSvg(input);
  assert.ok(!/foreignObject/.test(out));
  assert.ok(!/<div/.test(out));
});

test('sanitize: strips onclick handlers', () => {
  const input =
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" onclick="alert(1)" fill="red"/></svg>';
  const out = sanitizeSvg(input);
  assert.ok(!/onclick/i.test(out));
  assert.match(out, /fill="red"/);
});

test('sanitize: strips onload handlers (any on* attr)', () => {
  const input =
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0"/></svg>';
  const out = sanitizeSvg(input);
  assert.ok(!/onload/i.test(out));
});

test('sanitize: strips external href in <use>', () => {
  const input =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use href="http://evil.example/x.svg#icon"/></svg>';
  const out = sanitizeSvg(input);
  assert.ok(!/href="http/.test(out));
});

test('sanitize: keeps internal #id href on <use>', () => {
  const input =
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><symbol id="i"><rect x="0" y="0" width="5" height="5"/></symbol></defs><use href="#i"/></svg>';
  const out = sanitizeSvg(input);
  assert.match(out, /<use[^/>]*href="#i"/);
});

test('sanitize: strips unknown elements like <iframe>', () => {
  const input =
    '<svg xmlns="http://www.w3.org/2000/svg"><iframe src="x"/></svg>';
  const out = sanitizeSvg(input);
  assert.ok(!/iframe/i.test(out));
});

test('sanitize: strips style attribute', () => {
  const input =
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" style="behavior: url(x)"/></svg>';
  const out = sanitizeSvg(input);
  assert.ok(!/style=/.test(out));
});

test('sanitize: throws on non-string input', () => {
  assert.throws(() => sanitizeSvg(null), SvgSanitizationError);
  assert.throws(() => sanitizeSvg(42), SvgSanitizationError);
});

test('sanitize: throws on input that is not an SVG document', () => {
  // A plain HTML fragment does not parse as image/svg+xml root.
  assert.throws(
    () => sanitizeSvg('<html><body></body></html>'),
    SvgSanitizationError,
  );
});

test('sanitize: keeps <g>, <circle>, <rect>, <polygon>, <polyline>, <line>, <ellipse>', () => {
  const input =
    '<svg xmlns="http://www.w3.org/2000/svg">' +
    '<g><circle cx="1" cy="2" r="3"/><rect x="0" y="0" width="4" height="4"/>' +
    '<polygon points="0,0 1,1"/><polyline points="0,0 2,2"/>' +
    '<line x1="0" y1="0" x2="1" y2="1"/><ellipse cx="1" cy="1" rx="2" ry="3"/></g></svg>';
  const out = sanitizeSvg(input);
  for (const tag of [
    '<g',
    '<circle',
    '<rect',
    '<polygon',
    '<polyline',
    '<line',
    '<ellipse',
  ]) {
    assert.ok(out.includes(tag), `expected output to contain ${tag}: ${out}`);
  }
});

test('sanitize: keeps gradient elements + stop', () => {
  const input =
    '<svg xmlns="http://www.w3.org/2000/svg"><defs>' +
    '<linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient>' +
    '<radialGradient id="r"><stop offset="1" stop-color="#000"/></radialGradient>' +
    '</defs></svg>';
  const out = sanitizeSvg(input);
  assert.match(out, /<linearGradient/);
  assert.match(out, /<radialGradient/);
  assert.match(out, /<stop/);
});

test('sanitize: strips comments', () => {
  const input =
    '<svg xmlns="http://www.w3.org/2000/svg"><!-- malicious --><path d="M0 0"/></svg>';
  const out = sanitizeSvg(input);
  assert.ok(!/<!--/.test(out));
  assert.match(out, /<path/);
});
