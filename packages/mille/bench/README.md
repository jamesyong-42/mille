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
