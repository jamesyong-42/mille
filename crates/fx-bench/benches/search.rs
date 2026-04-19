// Phase 10.3 — criterion benches for nucleo-backed filename search.
//
// Two benches over a medium fixture (~1500 entries): an exact-filename
// query and a fuzzy (skip-char) query. Establishes a baseline for the
// Phase 12 regression guardrails; numbers are tracked in reports/.

use criterion::{criterion_group, criterion_main, Criterion};
use fx_bench::medium_tree;
use fx_core::{populate_store, search, walk, EntryStore, SearchOptions, WalkOptions};

fn build_snapshot() -> (
    tempfile::TempDir,
    std::sync::Arc<fx_core::StoreSnapshot>,
) {
    let (td, _) = medium_tree();
    let walked = walk(td.path(), WalkOptions::default()).expect("walk");
    let store = EntryStore::new();
    populate_store(&store, td.path(), &walked, None).expect("populate");
    let snap = store.snapshot();
    (td, snap)
}

fn bench_search_exact(c: &mut Criterion) {
    // Keep the TempDir alive for the whole bench — dropping it would
    // remove the underlying directory mid-run.
    let (_td, snap) = build_snapshot();

    c.bench_function("search_exact_medium", |b| {
        b.iter(|| {
            let _ = search(snap.as_ref(), "file_042.txt", &SearchOptions::default());
        });
    });
}

fn bench_search_fuzzy(c: &mut Criterion) {
    let (_td, snap) = build_snapshot();

    c.bench_function("search_fuzzy_medium", |b| {
        b.iter(|| {
            let _ = search(snap.as_ref(), "f42", &SearchOptions::default());
        });
    });
}

criterion_group!(benches, bench_search_exact, bench_search_fuzzy);
criterion_main!(benches);
