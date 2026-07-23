import { performance } from 'node:perf_hooks';

import { compareNaturalNames } from '../dist/natural-sort.js';

const COUNT = 100_000;
const source = Array.from(
  { length: COUNT },
  (_, index) => `module-${COUNT - index}-part-${(index * 7919) % 10_000}.ts`,
);
for (let warmup = 0; warmup < 3; warmup += 1) {
  source.slice().sort(compareNaturalNames);
}

const samples = [];
let sorted = [];
for (let iteration = 0; iteration < 10; iteration += 1) {
  const values = source.slice();
  const started = performance.now();
  values.sort(compareNaturalNames);
  samples.push(performance.now() - started);
  sorted = values;
}
samples.sort((a, b) => a - b);
const p50 = samples[Math.floor(samples.length * 0.5)];
const p95 = samples[Math.floor(samples.length * 0.95)];

if (sorted[0] !== 'module-1-part-2081.ts' || !sorted.at(-1)?.startsWith('module-100000-')) {
  throw new Error('natural sort produced an invalid boundary order');
}
if (p95 > 250) {
  throw new Error(`100k natural sibling sort exceeded 250 ms p95: ${p95.toFixed(2)} ms`);
}

console.log('| scenario | p50 | p95 |');
console.log('|---|---:|---:|');
console.log(
  `| natural sort ${COUNT.toLocaleString()} sibling names | ${p50.toFixed(2)} ms | ${p95.toFixed(2)} ms |`,
);
