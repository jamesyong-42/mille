// Phase 14.3 — integration tests for the agent-rules decoration
// companion.
//
// Coverage:
//   1. Every SURVEY-documented file path is matched by at least one
//      built-in matcher.
//   2. False-positive guard: bogus paths don't match.
//   3. registerAgentRulesDecorations returns a disposable handle.
//   4. Registered provider's `provide` returns a Decoration for matched
//      entries and null for clean ones.
//   5. Disposing unregisters the provider.
//   6. `additionalMatchers` extends defaults without replacing.
//   7. `matchers` replaces defaults entirely.
//   8. onDidChange returns a no-op disposable (static pattern set).
//   9. A provided matcher `id` and `label` surface via `tooltip`.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { registerAgentRulesDecorations, DEFAULT_MATCHERS } = await import(
  '../dist/agent-rules.js'
);

// ─── Fake engine ──────────────────────────────────────────────────────

function createFakeEngine() {
  const registered = [];
  let disposedCount = 0;
  const fx = {
    registerDecorationProvider(provider) {
      registered.push(provider);
      return {
        dispose() {
          disposedCount += 1;
        },
      };
    },
    _stats() {
      return { registered, disposedCount };
    },
  };
  return fx;
}

// Build a fake `Entry` with an explicit `path` so directory-based
// matchers can see the ancestor chain. The companion duck-types
// `.path` off whatever it's handed.
function entryFor(path, id = Math.floor(Math.random() * 1_000_000)) {
  const name = path.split('/').pop() ?? '';
  return {
    id,
    parentId: null,
    name,
    kind: 0,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
    path,
  };
}

// ─── Test 1: survey-documented paths matched by defaults ─────────────

test('every SURVEY-documented file path is matched by a built-in matcher', () => {
  const positives = [
    '/repo/.cursor/rules/my-rule.md',
    '/repo/.cursorrules',
    '/repo/.kiro/steering/backend.md',
    '/repo/.clinerules',
    '/repo/.clinerules.md',
    '/repo/.continue/config.json',
    '/repo/CLAUDE.md',
    '/repo/CLAUDE.local.md',
    '/repo/AGENTS.md',
    '/repo/.rules',
    '/repo/CODEX.md',
  ];
  for (const path of positives) {
    const matched = DEFAULT_MATCHERS.some((m) => m.test(path));
    assert.ok(matched, `expected a default matcher to fire for ${path}`);
  }
});

// ─── Test 2: false-positive guard ────────────────────────────────────

test('false-positive guard: spurious names do NOT match defaults', () => {
  const negatives = [
    '/repo/CLAUDE.md.txt',
    '/repo/docs/someclaudemd',
    '/repo/notcursor/rules/thing.md',
    '/repo/CLAUDEmd',
    '/repo/AGENTS.md.bak',
    '/repo/kiro/steering/backend.md',         // no leading dot on kiro
    '/repo/cursor/rules/x.md',                 // no leading dot
    '/repo/continue/config.json',              // no leading dot
    '/repo/README.md',
    '/repo/CLAUDE.other.md',                   // only CLAUDE.md / CLAUDE.local.md are valid
    '/repo/agentsmd',
    '/repo/MYCODEX.md',
    '/repo/.rulesfile',                        // .rules must be exact
  ];
  for (const path of negatives) {
    const matched = DEFAULT_MATCHERS.some((m) => m.test(path));
    assert.equal(matched, false, `expected NO default matcher to fire for ${path}`);
  }
});

// ─── Test 3: disposable handle ───────────────────────────────────────

test('registerAgentRulesDecorations returns a disposable handle', () => {
  const fx = createFakeEngine();
  const handle = registerAgentRulesDecorations({ fx, rootPath: '/repo' });
  assert.equal(typeof handle.dispose, 'function');
  handle.dispose();
  // Second dispose is idempotent.
  handle.dispose();
});

// ─── Test 4: provider returns Decoration for matched entries ─────────

test('provider.provide returns a Decoration for matched entries and null otherwise', () => {
  const fx = createFakeEngine();
  const handle = registerAgentRulesDecorations({ fx, rootPath: '/repo' });

  const { registered } = fx._stats();
  assert.equal(registered.length, 1, 'exactly one provider registered');
  const provider = registered[0];
  assert.equal(provider.id, 'agent-rules');

  const claudeEntry = entryFor('/repo/CLAUDE.md');
  const dec = provider.provide(claudeEntry);
  assert.ok(dec, 'CLAUDE.md must be decorated');
  assert.equal(typeof dec.badge, 'string');
  assert.ok(dec.badge.length > 0, 'badge must be non-empty');
  assert.equal(dec.tooltip, 'Claude memory');
  assert.equal(dec.propagate, false);

  const cursorRule = provider.provide(
    entryFor('/repo/.cursor/rules/my-rule.md'),
  );
  assert.ok(cursorRule);
  assert.equal(cursorRule.tooltip, 'Cursor rules');

  const kiro = provider.provide(
    entryFor('/repo/.kiro/steering/backend.md'),
  );
  assert.ok(kiro);
  assert.equal(kiro.tooltip, 'Kiro steering');

  // Non-matching entries return null.
  assert.equal(provider.provide(entryFor('/repo/src/index.ts')), null);
  assert.equal(provider.provide(entryFor('/repo/CLAUDE.md.txt')), null);

  handle.dispose();
});

// ─── Test 5: disposing unregisters the provider ──────────────────────

test('disposing the handle unregisters the provider', () => {
  const fx = createFakeEngine();
  const handle = registerAgentRulesDecorations({ fx, rootPath: '/repo' });
  const beforeDispose = fx._stats().disposedCount;
  handle.dispose();
  const afterDispose = fx._stats().disposedCount;
  assert.equal(
    afterDispose - beforeDispose,
    1,
    'engine registration must be disposed exactly once',
  );

  // After dispose, `provide` returns null even for matched paths.
  const provider = fx._stats().registered[0];
  assert.equal(
    provider.provide(entryFor('/repo/CLAUDE.md')),
    null,
    'post-dispose provide must return null',
  );
});

// ─── Test 6: additionalMatchers extends defaults ────────────────────

test('additionalMatchers extends defaults without replacing them', () => {
  const fx = createFakeEngine();
  const additional = [
    {
      id: 'windsurf-rules',
      label: 'Windsurf rules',
      test: (p) => p.endsWith('/.windsurfrules'),
    },
  ];
  const handle = registerAgentRulesDecorations({
    fx,
    rootPath: '/repo',
    additionalMatchers: additional,
  });

  const provider = fx._stats().registered[0];

  // Default match still fires.
  const claudeDec = provider.provide(entryFor('/repo/CLAUDE.md'));
  assert.ok(claudeDec, 'default matchers still active');
  assert.equal(claudeDec.tooltip, 'Claude memory');

  // Additional matcher fires.
  const wsDec = provider.provide(entryFor('/repo/.windsurfrules'));
  assert.ok(wsDec, 'additional matcher must fire');
  assert.equal(wsDec.tooltip, 'Windsurf rules');

  handle.dispose();
});

// ─── Test 7: matchers replaces defaults entirely ─────────────────────

test('matchers option replaces defaults entirely', () => {
  const fx = createFakeEngine();
  const custom = [
    {
      id: 'only-rules',
      label: 'Only rules',
      test: (p) => p.endsWith('/.only'),
    },
  ];
  const handle = registerAgentRulesDecorations({
    fx,
    rootPath: '/repo',
    matchers: custom,
  });

  const provider = fx._stats().registered[0];

  // Default matches must NOT fire when `matchers` is supplied.
  assert.equal(
    provider.provide(entryFor('/repo/CLAUDE.md')),
    null,
    'default CLAUDE.md matcher must be replaced',
  );
  assert.equal(
    provider.provide(entryFor('/repo/AGENTS.md')),
    null,
    'default AGENTS.md matcher must be replaced',
  );

  // Custom matcher does fire.
  const dec = provider.provide(entryFor('/repo/.only'));
  assert.ok(dec);
  assert.equal(dec.tooltip, 'Only rules');

  handle.dispose();
});

// ─── Test 8: onDidChange no-op disposable ────────────────────────────

test('provider.onDidChange returns a no-op disposable (static pattern set)', () => {
  const fx = createFakeEngine();
  const handle = registerAgentRulesDecorations({ fx, rootPath: '/repo' });
  const provider = fx._stats().registered[0];

  let calls = 0;
  const sub = provider.onDidChange(() => {
    calls += 1;
  });
  assert.equal(typeof sub.dispose, 'function');
  sub.dispose();
  // Calling dispose again is safe.
  sub.dispose();
  // We never fire change events — static matcher set.
  assert.equal(calls, 0);

  handle.dispose();
});

// ─── Test 9: custom providerId + badge override ─────────────────────

test('custom providerId and badge options surface on the provider', () => {
  const fx = createFakeEngine();
  const handle = registerAgentRulesDecorations({
    fx,
    rootPath: '/repo',
    providerId: 'my-custom-id',
    badge: 'AR',
  });
  const provider = fx._stats().registered[0];

  assert.equal(provider.id, 'my-custom-id');
  const dec = provider.provide(entryFor('/repo/AGENTS.md'));
  assert.ok(dec);
  assert.equal(dec.badge, 'AR');
  assert.equal(dec.tooltip, 'AGENTS.md');

  handle.dispose();
});
