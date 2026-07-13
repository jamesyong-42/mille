// Phase 3.11 — watcher end-to-end latency benches (SPEC §4.4, PLAN 3.11).
//
// Synthetic events drive each module in isolation so Criterion can attribute
// cost cleanly. Numbers feed the Phase 12 CI regression guardrails — for now
// the benches just establish a baseline and prove the modules can be run
// outside their unit tests.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, Criterion};
use mille_core::{
    coalesce_events, FsChangeEvent, IntentCache, IntentKind, RawEvent, RenamePairer,
    VolatileTracker,
};

fn pb(s: &str) -> PathBuf {
    PathBuf::from(s)
}

// ---------------------------------------------------------------------------
// Coalescer throughput.

fn bench_coalesce_events_tiny_batch_10(c: &mut Criterion) {
    // Ten raw events across three paths — mixed Create/Modify/Delete,
    // representative of a small editor save cycle.
    let raw = vec![
        RawEvent::Created(pb("/a")),
        RawEvent::Modified(pb("/a")),
        RawEvent::Modified(pb("/a")),
        RawEvent::Created(pb("/b")),
        RawEvent::Modified(pb("/b")),
        RawEvent::Deleted(pb("/b")),
        RawEvent::Modified(pb("/c")),
        RawEvent::Modified(pb("/c")),
        RawEvent::Modified(pb("/c")),
        RawEvent::Modified(pb("/c")),
    ];
    c.bench_function("coalesce_events_tiny_batch_10", |b| {
        b.iter(|| {
            let out = coalesce_events(black_box(&raw));
            black_box(out);
        })
    });
}

fn bench_coalesce_events_storm_1000(c: &mut Criterion) {
    // Simulates an npm-install storm: ~500 unique paths each touched by a
    // Create + one or two Modifies. Path count dominates coalescer cost.
    let mut raw = Vec::with_capacity(1000);
    for i in 0..500u32 {
        raw.push(RawEvent::Created(pb(&format!("/pkg/{i}"))));
        raw.push(RawEvent::Modified(pb(&format!("/pkg/{i}"))));
    }
    c.bench_function("coalesce_events_storm_1000", |b| {
        b.iter(|| {
            let out = coalesce_events(black_box(&raw));
            black_box(out);
        })
    });
}

// ---------------------------------------------------------------------------
// Rename pairer.

fn bench_rename_pairer_single_pair(c: &mut Criterion) {
    // Feed one matching pair through a fresh pairer each iteration.
    // Measures the "good path" pair-and-emit cost including the macOS
    // stat syscall (on macOS; other platforms skip the syscall).
    let from = pb("/tmp/does-not-exist-from");
    let to = pb("/tmp/does-not-exist-to");
    let events = vec![
        FsChangeEvent::Unknown { path: from.clone() },
        FsChangeEvent::Unknown { path: to.clone() },
    ];
    c.bench_function("rename_pairer_single_pair", |b| {
        b.iter(|| {
            let mut p = RenamePairer::new(Duration::from_secs(1));
            let out = p.feed(black_box(events.clone()), Instant::now());
            black_box(out);
        })
    });
}

fn bench_rename_pairer_no_pair_timeout(c: &mut Criterion) {
    // 100 Unknowns with no matching partners. Each odd-indexed Unknown
    // pairs with the preceding one under the Linux/fallback heuristic;
    // on macOS, stat outcomes alternate "gone" (odd i) / "gone" (all
    // nonexistent), so they still pair via the complementary-kind path
    // only when at least one exists. To force the pathological
    // "everyone queues then degrades" case, we use odd-count so one
    // always leaks; the benchmark measures the flush cost.
    let mut events = Vec::with_capacity(100);
    for i in 0..100u32 {
        events.push(FsChangeEvent::Unknown {
            path: pb(&format!("/tmp/nx/{i}")),
        });
    }
    let window = Duration::from_millis(10);
    c.bench_function("rename_pairer_no_pair_timeout", |b| {
        b.iter(|| {
            let mut p = RenamePairer::new(window);
            let t0 = Instant::now();
            let _ = p.feed(black_box(events.clone()), t0);
            // Second feed past the window triggers the degrade flush.
            let out = p.feed(Vec::new(), t0 + Duration::from_millis(50));
            black_box(out);
        })
    });
}

// ---------------------------------------------------------------------------
// Volatile tracker.

fn bench_volatile_tracker_record_hot_dir(c: &mut Criterion) {
    // 1000 events hammering a single dir. After the threshold (200) the
    // tracker enters the "refresh breach" path — the steady-state hot
    // loop. This is what we pay per event during an npm install.
    let dir = pb("/hot");
    c.bench_function("volatile_tracker_record_hot_dir", |b| {
        b.iter(|| {
            let mut t =
                VolatileTracker::with_config(200, Duration::from_secs(1), Duration::from_secs(2));
            let base = Instant::now();
            for i in 0..1000u64 {
                t.record(black_box(&dir), base + Duration::from_micros(i));
            }
            black_box(t.is_volatile(&dir));
        })
    });
}

// ---------------------------------------------------------------------------
// Intent cache.

fn bench_intent_cache_record_consume_roundtrip(c: &mut Criterion) {
    // Record and consume in a tight loop. Represents the steady state
    // during active editing where every write we make is immediately
    // echoed back by the watcher.
    let path = pb("/tmp/hot.txt");
    c.bench_function("intent_cache_record_consume_roundtrip", |b| {
        b.iter(|| {
            let mut cache = IntentCache::new();
            let now = Instant::now();
            for _ in 0..100 {
                cache.record(path.clone(), IntentKind::Modify, now);
                let hit = cache.consume(black_box(&path), IntentKind::Modify, now);
                black_box(hit);
            }
        })
    });
}

criterion_group!(
    watcher,
    bench_coalesce_events_tiny_batch_10,
    bench_coalesce_events_storm_1000,
    bench_rename_pairer_single_pair,
    bench_rename_pairer_no_pair_timeout,
    bench_volatile_tracker_record_hot_dir,
    bench_intent_cache_record_consume_roundtrip,
);
criterion_main!(watcher);
