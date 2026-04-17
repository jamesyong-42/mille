// Property + stress tests for EntryStore.
//
// These are integration tests (outside src/) so they exercise the public API
// only, the same way Phase 2 walker and the napi binding will.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use fx_core::{Entry, EntryId, EntryKind, EntryStore, FxError};
use proptest::prelude::*;

fn leaf(name: &str) -> Entry {
    Entry {
        id: EntryId(0),
        parent_id: None,
        name: name.into(),
        kind: EntryKind::File,
        size: 0,
        mtime_ms: 0,
        ctime_ms: 0,
        symlink_target_is_dir: None,
        path_segments: None,
        is_ignored: false,
        is_readonly: false,
        is_hidden: false,
    }
}

#[derive(Debug, Clone)]
enum Op {
    Insert(String),
    RemoveByIndex(usize), // index into the store's currently-known ids
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        "[a-z]{1,6}".prop_map(Op::Insert),
        (0usize..32).prop_map(Op::RemoveByIndex),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// path_to_id is a bijection with live entries across any sequence of ops.
    #[test]
    fn path_id_bijection(ops in prop::collection::vec(op_strategy(), 0..100)) {
        let store = EntryStore::new();
        let mut live_ids: Vec<EntryId> = Vec::new();
        let mut live_paths: Vec<PathBuf> = Vec::new();
        let mut counter = 0u64;

        for op in ops {
            match op {
                Op::Insert(name) => {
                    let path: PathBuf = format!("/{}_{}", name, counter).into();
                    counter += 1;
                    let id = store.insert(path.clone(), leaf(&name)).unwrap();
                    live_ids.push(id);
                    live_paths.push(path);
                }
                Op::RemoveByIndex(idx) => {
                    if live_ids.is_empty() { continue; }
                    let i = idx % live_ids.len();
                    let id = live_ids.remove(i);
                    live_paths.remove(i);
                    store.remove(id);
                }
            }
        }

        // Invariant: every (path, id) pair in the tracking vectors resolves
        // through both indexes of the store, and the store has exactly those.
        prop_assert_eq!(store.snapshot().entry_count(), live_ids.len());
        for (id, path) in live_ids.iter().zip(live_paths.iter()) {
            prop_assert!(store.get_by_id(*id).is_some(), "id lost: {:?}", id);
            let by_path = store.get_by_path(path);
            prop_assert!(by_path.is_some(), "path lost: {:?}", path);
            prop_assert_eq!(by_path.map(|e| e.id), Some(*id));
        }
    }

    /// tree_version is monotonic across any sequence of ops that mutate.
    #[test]
    fn tree_version_monotonic(ops in prop::collection::vec(op_strategy(), 0..100)) {
        let store = EntryStore::new();
        let mut prev = store.tree_version();
        let mut live: Vec<EntryId> = Vec::new();
        let mut counter = 0u64;

        for op in ops {
            let before = store.tree_version();
            match op {
                Op::Insert(name) => {
                    let path: PathBuf = format!("/{}_{}", name, counter).into();
                    counter += 1;
                    let id = store.insert(path, leaf(&name)).unwrap();
                    live.push(id);
                    prop_assert!(store.tree_version() > before);
                }
                Op::RemoveByIndex(idx) => {
                    if live.is_empty() { continue; }
                    let i = idx % live.len();
                    let id = live.remove(i);
                    if store.remove(id).is_some() {
                        prop_assert!(store.tree_version() > before);
                    }
                }
            }
            prop_assert!(store.tree_version() >= prev);
            prev = store.tree_version();
        }
    }
}

#[test]
fn eight_threads_allocate_distinct_ids() {
    const THREADS: usize = 8;
    const PER_THREAD: usize = 1000;
    let store = Arc::new(EntryStore::new());

    let mut handles = Vec::new();
    for t in 0..THREADS {
        let store = store.clone();
        handles.push(std::thread::spawn(move || {
            let mut ids = Vec::with_capacity(PER_THREAD);
            for i in 0..PER_THREAD {
                let path: PathBuf = format!("/t{}/n{}", t, i).into();
                ids.push(store.insert(path, leaf(&format!("n{}", i))).unwrap());
            }
            ids
        }));
    }

    let mut all: HashSet<EntryId> = HashSet::new();
    for h in handles {
        for id in h.join().unwrap() {
            assert!(all.insert(id), "duplicate id under contention");
            assert!(id.raw() < (1u64 << 53), "id exceeds 2^53 safe-int ceiling");
        }
    }
    assert_eq!(all.len(), THREADS * PER_THREAD);
    assert_eq!(store.snapshot().entry_count(), THREADS * PER_THREAD);
}

#[test]
fn writer_plus_readers_no_deadlock() {
    // One writer doing ~15k inserts interleaved with removes;
    // four readers hammering snapshot() concurrently. Test is "no crash, no hang".
    const WRITES: usize = 10_000;
    const REMOVES: usize = 5_000;
    let store = Arc::new(EntryStore::new());
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let mut readers = Vec::new();
    for _ in 0..4 {
        let store = store.clone();
        let stop = stop.clone();
        readers.push(std::thread::spawn(move || {
            let mut reads: u64 = 0;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let snap = store.snapshot();
                // Touch the snapshot so the compiler can't optimize the load away.
                let _ = snap.entry_count();
                let _ = snap.tree_version();
                reads += 1;
            }
            reads
        }));
    }

    let writer = {
        let store = store.clone();
        std::thread::spawn(move || {
            let mut live = Vec::new();
            for i in 0..WRITES {
                let path: PathBuf = format!("/w/{}", i).into();
                let id = store.insert(path, leaf(&format!("n{}", i))).unwrap();
                live.push(id);
            }
            for i in 0..REMOVES {
                store.remove(live[i]);
            }
        })
    };

    writer.join().unwrap();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let total_reads: u64 = readers.into_iter().map(|h| h.join().unwrap()).sum();
    assert!(total_reads > 0, "readers never observed a snapshot");
    assert_eq!(
        store.snapshot().entry_count(),
        WRITES - REMOVES,
        "final entry count mismatch"
    );
}

#[test]
fn entry_id_exhausted_at_exactly_2_pow_53() {
    let store = EntryStore::new();
    store.__set_counter_for_tests((1u64 << 53) - 1);
    // The last allocation before the ceiling must succeed.
    let id = store.insert("/last".into(), leaf("last")).unwrap();
    assert_eq!(id.raw(), (1u64 << 53) - 1);
    // The next one must refuse.
    let err = store.insert("/past".into(), leaf("past")).unwrap_err();
    assert!(matches!(err, FxError::EntryIdExhausted));
    // And stay refused.
    let err2 = store.insert("/past2".into(), leaf("past2")).unwrap_err();
    assert!(matches!(err2, FxError::EntryIdExhausted));
}
