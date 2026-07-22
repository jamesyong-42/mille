import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

test('published tokens scope transitions to marked rows and disable motion accessibly', async () => {
  const css = await readFile(new URL('../tokens.css', import.meta.url), 'utf8');

  assert.match(css, /\.mille-row\[data-mille-repositioning="true"\]/);
  assert.doesNotMatch(
    css,
    /data-mille-layout-animating="true"\]\s+\.mille-row\s*\{/,
    'published CSS must not transition every mounted row',
  );
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\[data-mille-chevron\] svg/);
});
