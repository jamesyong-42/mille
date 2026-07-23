# Mille core benchmarks

## Viewport retention

```sh
pnpm bench:viewport
```

The harness handshakes with only the root entry, installs 50,000 authoritative
ordered child IDs plus the first 64-row viewport, and then moves that viewport
200 times against a mirror capped at 4,096 full entries. Every move must retain
all mounted rows, stay within the cap, and eventually evict the first cold
window. It reports root hydration, structural-metadata installation, and
viewport-patch encoding plus decode/apply p50/p95/max latency. It also compares
the average binary payload with the equivalent JSON and requires at least a 60%
size reduction. A MessageChannel sub-benchmark reports median structured-clone
plus decode time for JSON and binary patches using the production decoders.

Arguments can override the fixture:

```sh
pnpm bench:viewport -- --entries 100000 --cap 8192 --viewport 100 --moves 500
```

Timing values are reporters; the retention, eviction, and capacity invariants
are hard gates that exit non-zero.

## File nesting

```sh
pnpm bench:nesting
```

The native harness creates one 50,001-entry directory containing 20,000 source
and companion-file pairs plus 10,000 unrelated files. It verifies projected
cardinality and disclosure state, reports the cold plan, then measures
projected-child lookup plus a 200-row viewport over 40 warm samples. The
default gates are 100 ms for the cold plan and 10 ms warm p95. Override fixture
size or budgets with `MILLE_NESTING_PAIRS`,
`MILLE_NESTING_UNRELATED`, `MILLE_NESTING_COLD_BUDGET_MS`, and
`MILLE_NESTING_P95_BUDGET_MS`.
