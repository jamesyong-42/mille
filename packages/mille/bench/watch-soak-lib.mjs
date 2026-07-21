import { summarizeLatencies } from '../../../apps/playground/scripts/watch-bench-lib.mjs';

export function snapshotEntries(snapshot) {
  const entries = [];
  const stack = [...snapshot.roots()].reverse();
  const visited = new Set();

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry || visited.has(entry.id)) continue;
    visited.add(entry.id);
    entries.push(entry);

    const children = snapshot.childrenOf(entry.id);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = snapshot.getById(children[index]);
      if (child) stack.push(child);
    }
  }

  return entries;
}

function entryMatches(entry, expected) {
  return (
    entry.name === expected.name &&
    (expected.kind === undefined || entry.kind === expected.kind) &&
    (expected.size === undefined || entry.size === expected.size)
  );
}

export function evaluateExpectation(snapshot, expectation) {
  const entries = snapshotEntries(snapshot);
  const missing = expectation.present.filter(
    (expected) => !entries.some((entry) => entryMatches(entry, expected)),
  );
  const unexpected = expectation.absent.filter((name) =>
    entries.some((entry) => entry.name === name),
  );

  return {
    ok: missing.length === 0 && unexpected.length === 0,
    missing,
    unexpected,
    visibleEntryCount: entries.length,
  };
}

export async function waitForExpectation(fx, expectation, { timeoutMs, pollMs = 5 }) {
  const deadline = performance.now() + timeoutMs;
  let result = evaluateExpectation(fx.getSnapshot(), expectation);

  while (!result.ok && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    result = evaluateExpectation(fx.getSnapshot(), expectation);
  }

  return result;
}

export function summarizeByKind(observations) {
  const values = new Map();
  for (const observation of observations) {
    const bucket = values.get(observation.kind) ?? [];
    bucket.push(observation.latencyMs);
    values.set(observation.kind, bucket);
  }

  return Object.fromEntries(
    [...values.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, latencies]) => [
        kind,
        { count: latencies.length, ...summarizeLatencies(latencies) },
      ]),
  );
}
