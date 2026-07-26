// Phase 2.7 — walker + summary-query criterion suite.
//
// Targets (SPEC §7):
//   - walker cold walk: < 20ms for medium (≈1500 entries)
//   - populate_store: < 30ms for medium
//   - visible_rows (100-row slice): < 0.2ms on populated snapshot
//   - visible_row_count (all expanded): < 0.05ms
//   - visible_row_index (last row): < 0.2ms on populated snapshot
//   - visible_row_ids (full order): faster than full row materialization
//   - indexed path lookup: < 0.01ms on populated snapshot
//   - payload-free typeahead full miss: < 0.2ms on populated snapshot

use std::collections::HashSet;

use criterion::{criterion_group, criterion_main, Criterion};
use mille_bench::{large_query_tree, medium_tree};
use mille_core::{populate_store, walk, EntryStore, VisibleRowsQuery, WalkOptions};
// Used only by the `#[cfg(unix)]` symlink benches below; ungated these are
// unused imports on Windows, which `-D warnings` rejects.
#[cfg(unix)]
use mille_core::{walk_with_ignore, IgnoreMatcher};

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

fn bench_visible_row_ids_full(c: &mut Criterion) {
    let (td, _) = medium_tree();
    let walked = walk(td.path(), WalkOptions::default()).unwrap();
    let store = EntryStore::new();
    populate_store(&store, td.path(), &walked, None).unwrap();
    let snap = store.snapshot();
    let expanded = expanded_set_all(&store);

    c.bench_function("visible_row_ids_full_medium", |b| {
        b.iter(|| {
            let _ = snap.visible_row_ids(VisibleRowsQuery {
                expanded: &expanded,
                offset: 0,
                limit: u32::MAX,
                include_ignored: false,
            });
        })
    });
}

fn bench_visible_row_index(c: &mut Criterion) {
    let (td, _) = medium_tree();
    let walked = walk(td.path(), WalkOptions::default()).unwrap();
    let store = EntryStore::new();
    populate_store(&store, td.path(), &walked, None).unwrap();
    let snap = store.snapshot();
    let expanded = expanded_set_all(&store);
    let target = snap
        .visible_rows(VisibleRowsQuery {
            expanded: &expanded,
            offset: 0,
            limit: u32::MAX,
            include_ignored: false,
        })
        .last()
        .expect("medium fixture has visible rows")
        .id;

    c.bench_function("visible_row_index_last_medium", |b| {
        b.iter(|| {
            let _ = snap.visible_row_index(target, &expanded, false);
        })
    });
}

fn bench_visible_row_index_large(c: &mut Criterion) {
    let (td, entry_count) = large_query_tree();
    let walked = walk(td.path(), WalkOptions::default()).unwrap();
    assert_eq!(walked.len(), entry_count);
    let store = EntryStore::new();
    populate_store(&store, td.path(), &walked, None).unwrap();
    let snap = store.snapshot();
    let expanded = expanded_set_all(&store);
    let target = snap
        .visible_rows(VisibleRowsQuery {
            expanded: &expanded,
            offset: 0,
            limit: u32::MAX,
            include_ignored: false,
        })
        .last()
        .expect("large fixture has visible rows")
        .id;

    c.bench_function("visible_row_index_last_large_8590", |b| {
        b.iter(|| {
            let _ = snap.visible_row_index(target, &expanded, false);
        })
    });
}

fn bench_indexed_path_lookup(c: &mut Criterion) {
    let (td, _) = medium_tree();
    let walked = walk(td.path(), WalkOptions::default()).unwrap();
    let target = walked
        .last()
        .expect("medium fixture has entries")
        .path
        .clone();
    let store = EntryStore::new();
    populate_store(&store, td.path(), &walked, None).unwrap();

    c.bench_function("indexed_path_lookup_last_medium", |b| {
        b.iter(|| {
            let _ = store.get_by_path(&target);
        })
    });
}

fn bench_visible_prefix_miss(c: &mut Criterion) {
    let (td, _) = medium_tree();
    let walked = walk(td.path(), WalkOptions::default()).unwrap();
    let store = EntryStore::new();
    populate_store(&store, td.path(), &walked, None).unwrap();
    let snap = store.snapshot();
    let expanded = expanded_set_all(&store);

    c.bench_function("visible_prefix_full_miss_medium", |b| {
        b.iter(|| {
            let _ = snap.visible_prefix_match("§-absent", None, false, &expanded, false);
        })
    });
}

fn bench_visible_prefix_miss_large(c: &mut Criterion) {
    let (td, entry_count) = large_query_tree();
    let walked = walk(td.path(), WalkOptions::default()).unwrap();
    assert_eq!(walked.len(), entry_count);
    let store = EntryStore::new();
    populate_store(&store, td.path(), &walked, None).unwrap();
    let snap = store.snapshot();
    let expanded = expanded_set_all(&store);

    c.bench_function("visible_prefix_full_miss_large_8590", |b| {
        b.iter(|| {
            let _ = snap.visible_prefix_match("§-absent", None, false, &expanded, false);
        })
    });
}

/// v0.2 B3 regression bench. Fixture: `repo_entries` real files under `src/`
/// plus a `node_modules` symlink into a `store_entries`-file sibling.
/// `walk_with_ignore` with a `node_modules/` rule should walk in O(repo)
/// time — before B3 it walked O(repo + store). We size the fixture so
/// that a regression (i.e. the walker descending the symlink) would be
/// an order of magnitude slower and easily visible in criterion output.
#[cfg(unix)]
fn bench_pnpm_style_ignore(c: &mut Criterion) {
    use mille_bench::pnpm_style_fixture;

    // ~10k repo files + ~100k store files. Criterion re-runs on the same
    // fixture, so cost is just the walk itself (no rebuild per iter).
    let (repo, _store) = pnpm_style_fixture(10_000, 100_000);
    let mut seeded = IgnoreMatcher::new();
    seeded
        .add_from_file(&repo.path().join(".gitignore"))
        .expect("seed gitignore");

    c.bench_function("walker_pnpm_style_ignored_10k_repo_100k_store", |b| {
        b.iter(|| {
            let _ = walk_with_ignore(repo.path(), WalkOptions::default(), &seeded).unwrap();
        })
    });
}

#[cfg(unix)]
criterion_group!(
    walker,
    bench_walker_serial,
    bench_walker_parallel,
    bench_populate_store,
    bench_visible_row_count,
    bench_visible_rows_100,
    bench_visible_rows_full,
    bench_visible_row_ids_full,
    bench_visible_row_index,
    bench_visible_row_index_large,
    bench_indexed_path_lookup,
    bench_visible_prefix_miss,
    bench_visible_prefix_miss_large,
    bench_pnpm_style_ignore,
);

#[cfg(not(unix))]
criterion_group!(
    walker,
    bench_walker_serial,
    bench_walker_parallel,
    bench_populate_store,
    bench_visible_row_count,
    bench_visible_rows_100,
    bench_visible_rows_full,
    bench_visible_row_ids_full,
    bench_visible_row_index,
    bench_visible_row_index_large,
    bench_indexed_path_lookup,
    bench_visible_prefix_miss,
    bench_visible_prefix_miss_large,
);

criterion_main!(walker);
