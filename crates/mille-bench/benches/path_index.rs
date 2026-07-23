use criterion::{criterion_group, criterion_main, Criterion};
use mille_bench::medium_tree;
use mille_core::{populate_store, walk, EntryStore, WalkOptions};

fn bench_indexed_id_path_lookup(c: &mut Criterion) {
    let (fixture, _) = medium_tree();
    let walked = walk(fixture.path(), WalkOptions::default()).expect("walk fixture");
    let store = EntryStore::new();
    let ids =
        populate_store(&store, fixture.path(), &walked, None).expect("populate fixture store");
    let target = *ids.last().expect("medium fixture has entries");

    c.bench_function("indexed_id_path_lookup_last_medium", |b| {
        b.iter(|| {
            let _ = store.path_for_id(target);
        })
    });
}

criterion_group!(benches, bench_indexed_id_path_lookup);
criterion_main!(benches);
