// Phase 2.7 — walker + summary-query criterion suite.
//
// Targets (SPEC §7):
//   - walker cold walk: < 20ms for medium (≈1500 entries)
//   - populate_store: < 30ms for medium
//   - visible_rows (100-row slice): < 0.2ms on populated snapshot
//   - visible_row_count (all expanded): < 0.05ms

use std::collections::HashSet;

use criterion::{criterion_group, criterion_main, Criterion};
use mille_bench::medium_tree;
use mille_core::{populate_store, walk, EntryStore, VisibleRowsQuery, WalkOptions};

/// Helper: criterion can't see `VisibleRowsQuery` construction easily without
/// holding the expansion Set outside. We expose an "all expanded" helper that
/// folds every known id into the Set.
fn expanded_set_all(store: &EntryStore) -> HashSet<mille_core::EntryId> {
    let snap = store.snapshot();
    snap.entries_iter().map(|(id, _)| id).collect()
}

fn bench_walker_serial(c: &mut Criterion) {
    let (td, _) = medium_tree();
    c.bench_function("walker_serial_medium", |b| {
        b.iter(|| {
            let _ = walk(td.path(), WalkOptions::default()).unwrap();
        })
    });
}

fn bench_walker_parallel(c: &mut Criterion) {
    let (td, _) = medium_tree();
    c.bench_function("walker_parallel4_medium", |b| {
        b.iter(|| {
            let _ = walk(
                td.path(),
                WalkOptions {
                    parallelism: 4,
                    ..Default::default()
                },
            )
            .unwrap();
        })
    });
}

fn bench_populate_store(c: &mut Criterion) {
    let (td, _) = medium_tree();
    let walked = walk(td.path(), WalkOptions::default()).unwrap();
    c.bench_function("populate_store_medium", |b| {
        b.iter(|| {
            let store = EntryStore::new();
            populate_store(&store, td.path(), &walked, None).unwrap();
        })
    });
}

fn bench_visible_row_count(c: &mut Criterion) {
    let (td, _) = medium_tree();
    let walked = walk(td.path(), WalkOptions::default()).unwrap();
    let store = EntryStore::new();
    populate_store(&store, td.path(), &walked, None).unwrap();
    let snap = store.snapshot();
    let expanded = expanded_set_all(&store);

    c.bench_function("visible_row_count_all_expanded_medium", |b| {
        b.iter(|| {
            let _ = snap.visible_row_count(&expanded, false);
        })
    });
}

fn bench_visible_rows_100(c: &mut Criterion) {
    let (td, _) = medium_tree();
    let walked = walk(td.path(), WalkOptions::default()).unwrap();
    let store = EntryStore::new();
    populate_store(&store, td.path(), &walked, None).unwrap();
    let snap = store.snapshot();
    let expanded = expanded_set_all(&store);

    c.bench_function("visible_rows_100_slice_medium", |b| {
        b.iter(|| {
            let _ = snap.visible_rows(VisibleRowsQuery {
                expanded: &expanded,
                offset: 0,
                limit: 100,
                include_ignored: false,
            });
        })
    });
}

fn bench_visible_rows_full(c: &mut Criterion) {
    let (td, _) = medium_tree();
    let walked = walk(td.path(), WalkOptions::default()).unwrap();
    let store = EntryStore::new();
    populate_store(&store, td.path(), &walked, None).unwrap();
    let snap = store.snapshot();
    let expanded = expanded_set_all(&store);

    // Reference: materializing every visible row. Normally the UI asks for a
    // viewport slice, but this number tells us the algorithm's asymptote.
    c.bench_function("visible_rows_unlimited_medium", |b| {
        b.iter(|| {
            let _ = snap.visible_rows(VisibleRowsQuery {
                expanded: &expanded,
                offset: 0,
                limit: u32::MAX,
                include_ignored: false,
            });
        })
    });
}

criterion_group!(
    walker,
    bench_walker_serial,
    bench_walker_parallel,
    bench_populate_store,
    bench_visible_row_count,
    bench_visible_rows_100,
    bench_visible_rows_full,
);
criterion_main!(walker);
