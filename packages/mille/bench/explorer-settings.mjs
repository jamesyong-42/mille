import { performance } from 'node:perf_hooks';

import {
  EXPLORER_SETTINGS_LIMITS,
  parseExplorerSettings,
  resolveExplorerSettings,
  serializeExplorerSettings,
} from '../dist/index.js';

const workspaces = {};
for (let workspace = 0; workspace < EXPLORER_SETTINGS_LIMITS.workspaces; workspace += 1) {
  const roots = {};
  for (let root = 0; root < EXPLORER_SETTINGS_LIMITS.rootsPerWorkspace; root += 1) {
    roots[`root-${root}`] = {
      sortBy: root % 3 === 0 ? 'name' : root % 3 === 1 ? 'type' : 'modified',
      caseSensitive: root % 2 === 0,
      excludeGlobs: [`generated-${root}/**`],
    };
  }
  workspaces[`workspace-${workspace}`] = {
    settings: { foldersOnTop: workspace % 2 === 0 },
    roots,
  };
}
const source = { version: 1, global: { compactFolders: true }, workspaces };
const encoded = JSON.stringify(source);

function measure(iterations, operation) {
  const samples = [];
  let result;
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    result = operation();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    result,
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.floor(samples.length * 0.95)],
  };
}

const parse = measure(20, () => parseExplorerSettings(encoded));
if (!parse.result) throw new Error('maximum settings document did not parse');
const resolve = measure(100, () => {
  for (let index = 0; index < 1_000; index += 1) {
    resolveExplorerSettings(
      parse.result,
      `workspace-${index % EXPLORER_SETTINGS_LIMITS.workspaces}`,
      `root-${index % EXPLORER_SETTINGS_LIMITS.rootsPerWorkspace}`,
    );
  }
});
const serialize = measure(20, () => serializeExplorerSettings(parse.result));

if (parse.p95 > 100 || resolve.p95 > 100 || serialize.p95 > 100) {
  throw new Error(
    `settings budget exceeded: parse=${parse.p95.toFixed(2)} ` +
      `resolve1000=${resolve.p95.toFixed(2)} serialize=${serialize.p95.toFixed(2)} ms`,
  );
}
console.log('| settings operation | p50 | p95 |');
console.log('|---|---:|---:|');
console.log(
  `| parse ${Buffer.byteLength(encoded).toLocaleString()} bytes | ${parse.p50.toFixed(2)} ms | ${parse.p95.toFixed(2)} ms |`,
);
console.log(
  `| resolve 1,000 root views | ${resolve.p50.toFixed(2)} ms | ${resolve.p95.toFixed(2)} ms |`,
);
console.log(
  `| serialize normalized document | ${serialize.p50.toFixed(2)} ms | ${serialize.p95.toFixed(2)} ms |`,
);
