// Crash-resume property tests (Phase 4 commit 4.5).
//
// Two invariants:
//   A) write_snapshot ∘ read_snapshot == identity on the serialized state.
//   B) events_since reports a superset of every real filesystem mutation
//      made after a snapshot was taken.
//
// Kept in a sibling file from `proptests.rs` so a flake in one invariant
// doesn't gate the other. Bounded to 32 cases per test to keep the suite
// under ~2s total.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use mille_core::{
    events_since, populate_store, read_snapshot, walk, write_snapshot, Entry, EntryId, EntryKind,
    EntryStore, ResumeEvent, RootStat, WalkOptions,
};
use proptest::prelude::*;
use tempfile::TempDir;

// ============================================================================
// Invariant A — pure in-memory + disk-IO roundtrip.
// ============================================================================
//
// Reuses the Op::Insert / Op::RemoveByIndex pattern from proptests.rs. Paths
// are synthetic (/a_0, /b_1, ...), not real filesystem paths — the roundtrip
// exercises bincode + atomic file replace, not the walker.

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
    RemoveByIndex(usize),
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        "[a-z]{1,6}".prop_map(Op::Insert),
        (0usize..32).prop_map(Op::RemoveByIndex),
    ]
}

fn mutation_sequence(range: std::ops::Range<usize>) -> impl Strategy<Value = Vec<Op>> {
    prop::collection::vec(op_strategy(), range)
}

/// Apply `ops` to a fresh EntryStore. Returns (store, next_entry_id) where
/// next_entry_id mirrors what the allocator would yield next. Counter is
/// tracked alongside since the store's internal counter is private.
fn apply_ops(ops: &[Op]) -> (EntryStore, u64) {
    let store = EntryStore::new();
    let mut live: Vec<EntryId> = Vec::new();
    let mut counter = 0u64;
    let mut seq = 0u64;

    for op in ops {
        match op {
            Op::Insert(name) => {
                let path: PathBuf = format!("/{}_{}", name, seq).into();
                seq += 1;
                if let Ok(id) = store.insert(path, leaf(name)) {
                    live.push(id);
                    counter += 1;
                }
            }
            Op::RemoveByIndex(idx) => {
                if live.is_empty() {
                    continue;
                }
                let i = idx % live.len();
                let id = live.remove(i);
                store.remove(id);
            }
        }
    }
    (store, counter)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    /// write_snapshot() followed by read_snapshot() yields the same fields.
    #[test]
    fn write_read_roundtrip_preserves_state(ops in mutation_sequence(0..30)) {
        let (store, next_entry_id) = apply_ops(&ops);
        let snap = store.snapshot();

        let td = TempDir::new().unwrap();
        let path = td.path().join("snap.bin");

        // Synthesize RootStats from the in-memory roots — their on-disk paths
        // don't need to exist; Invariant A only checks serde roundtripping.
        let root_stats: Vec<RootStat> = snap
            .roots()
            .iter()
            .map(|id| RootStat {
                path: PathBuf::from(format!("/root_{}", id.raw())),
                mtime_ms: id.raw() as i64,
            })
            .collect();

        write_snapshot(&snap, next_entry_id, &root_stats, &path).unwrap();
        let loaded = read_snapshot(&path).unwrap();

        // Top-level fields.
        prop_assert_eq!(loaded.tree_version, snap.tree_version());
        prop_assert_eq!(&loaded.roots, &snap.roots().to_vec());
        prop_assert_eq!(loaded.next_entry_id, next_entry_id);
        prop_assert_eq!(&loaded.root_stats, &root_stats);

        // Entry table: every live id maps to a byte-equal Entry.
        prop_assert_eq!(loaded.entries.len(), snap.entry_count());
        for (id, arc) in snap.entries_iter() {
            let got = loaded.entries.get(&id);
            prop_assert!(got.is_some(), "entry id {:?} missing after roundtrip", id);
            prop_assert_eq!(got.unwrap(), &(**arc));
        }

        // children map: snapshot stores only non-empty child lists.
        let mut expected_children: BTreeMap<EntryId, Vec<EntryId>> = BTreeMap::new();
        for (id, _) in snap.entries_iter() {
            let kids = snap.children_of(id);
            if !kids.is_empty() {
                expected_children.insert(id, kids.to_vec());
            }
        }
        prop_assert_eq!(&loaded.children, &expected_children);

        // Summary caches: direct_child_counts is keyed only on parents that
        // have ever had a child; the other two caches cover every live id.
        for (id, _) in snap.entries_iter() {
            if let Some(c) = snap.direct_child_count(id) {
                prop_assert_eq!(loaded.direct_child_counts.get(&id).copied(), Some(c));
            }
            prop_assert_eq!(
                loaded.descendant_visible_counts.get(&id).copied(),
                Some(snap.subtree_visible_count(id))
            );
            prop_assert_eq!(
                loaded.descendant_total_sizes.get(&id).copied(),
                Some(snap.subtree_total_size(id))
            );
        }
    }
}

// ============================================================================
// Invariant B — resume-and-diff detects every real filesystem change.
// ============================================================================

#[derive(Clone, Debug)]
#[allow(dead_code)]
#[allow(clippy::enum_variant_names)]
enum FsMutation {
    CreateFile { rel_path: PathBuf, bytes: Vec<u8> },
    DeleteFile { rel_path: PathBuf },
    ModifyFile { rel_path: PathBuf, bytes: Vec<u8> },
}

#[derive(Clone, Debug)]
struct TreeShape {
    dirs: Vec<PathBuf>,
    files: Vec<(PathBuf, Vec<u8>)>,
}

/// Path segment strategy — lowercase, 1..=4 chars. Small alphabet keeps
/// collision rates interesting without blowing up state.
fn segment() -> impl Strategy<Value = String> {
    "[a-z]{1,4}".prop_map(|s| s)
}

/// 1..=3 segments joined by std::path::MAIN_SEPARATOR semantics (PathBuf).
fn rel_path_strategy() -> impl Strategy<Value = PathBuf> {
    prop::collection::vec(segment(), 1..=3).prop_map(|segs| {
        let mut p = PathBuf::new();
        for s in segs {
            p.push(s);
        }
        p
    })
}

/// Small byte payload. Length range is open enough that a Modify is extremely
/// likely to change file size — which flips events_since regardless of mtime
/// granularity (flake-defense strategy (b) from the brief).
fn bytes_strategy() -> impl Strategy<Value = Vec<u8>> {
    prop::collection::vec(any::<u8>(), 0..=32)
}

fn tree_shape(file_count_range: std::ops::Range<usize>) -> impl Strategy<Value = TreeShape> {
    let files = prop::collection::vec((rel_path_strategy(), bytes_strategy()), file_count_range);
    files.prop_map(|files| {
        // Derive the set of parent-directory paths implied by each file.
        let mut dirs: BTreeSet<PathBuf> = BTreeSet::new();
        for (fp, _) in &files {
            if let Some(parent) = fp.parent() {
                let mut acc = PathBuf::new();
                for comp in parent.components() {
                    acc.push(comp);
                    dirs.insert(acc.clone());
                }
            }
        }
        // Deduplicate files by path (last write wins) and drop any file
        // whose path collides with a required directory — otherwise
        // materialize() would fail with IsADirectory.
        let mut dedup: BTreeMap<PathBuf, Vec<u8>> = BTreeMap::new();
        for (p, b) in files {
            if dirs.contains(&p) {
                continue;
            }
            dedup.insert(p, b);
        }
        TreeShape {
            dirs: dirs.into_iter().collect(),
            files: dedup.into_iter().collect(),
        }
    })
}

fn fs_mutation_strategy() -> impl Strategy<Value = FsMutation> {
    prop_oneof![
        (rel_path_strategy(), bytes_strategy())
            .prop_map(|(rel_path, bytes)| FsMutation::CreateFile { rel_path, bytes }),
        rel_path_strategy().prop_map(|rel_path| FsMutation::DeleteFile { rel_path }),
        (rel_path_strategy(), bytes_strategy())
            .prop_map(|(rel_path, bytes)| FsMutation::ModifyFile { rel_path, bytes }),
    ]
}

fn fs_mutation_sequence(range: std::ops::Range<usize>) -> impl Strategy<Value = Vec<FsMutation>> {
    prop::collection::vec(fs_mutation_strategy(), range)
}

/// Materialize a TreeShape under `root`. mkdir -p all dirs, then write files.
fn materialize(root: &Path, shape: &TreeShape) -> std::io::Result<()> {
    for d in &shape.dirs {
        fs::create_dir_all(root.join(d))?;
    }
    for (p, bytes) in &shape.files {
        let full = root.join(p);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&full, bytes)?;
    }
    Ok(())
}

/// Snapshot a real directory into a ResumeSnapshot on disk, then read it back.
/// Returns the loaded ResumeSnapshot so the test can feed it to events_since.
fn snapshot_real_dir(root: &Path, snap_path: &Path) -> mille_core::ResumeSnapshot {
    let store = EntryStore::new();
    let walked = walk(
        root,
        WalkOptions {
            include_hidden: true,
            include_root: true,
            ..WalkOptions::default()
        },
    )
    .unwrap();
    populate_store(&store, root, &walked, None).unwrap();

    let counter = AtomicU64::new(walked.len() as u64);
    let snap = store.snapshot();

    let root_mtime = fs::metadata(root)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let root_stats = vec![RootStat {
        path: root.to_path_buf(),
        mtime_ms: root_mtime,
    }];

    write_snapshot(
        &snap,
        counter.load(Ordering::Relaxed),
        &root_stats,
        snap_path,
    )
    .unwrap();
    read_snapshot(snap_path).unwrap()
}

/// Apply an FsMutation to a real tempdir. Silently skips operations that
/// can't land (e.g. DeleteFile on a missing path, ModifyFile on a path that
/// was never created). The caller compensates by tracking which mutations
/// actually took effect.
fn apply_mutation(root: &Path, m: &FsMutation) -> Option<FsMutation> {
    match m {
        FsMutation::CreateFile { rel_path, bytes } => {
            let full = root.join(rel_path);
            // Don't clobber an existing directory — would turn Create into
            // an Err that we'd lose track of. If something already exists at
            // this path, treat as a no-op and skip tracking.
            if full.exists() && full.is_dir() {
                return None;
            }
            if let Some(parent) = full.parent() {
                if fs::create_dir_all(parent).is_err() {
                    return None;
                }
            }
            // If the path already existed as a file we're effectively modifying,
            // but the FsMutation variant still tracks it as a Create → the
            // test accepts Appeared-or-Modified events as a match (see below).
            if fs::write(&full, bytes).is_ok() {
                Some(m.clone())
            } else {
                None
            }
        }
        FsMutation::DeleteFile { rel_path } => {
            let full = root.join(rel_path);
            if full.is_file() && fs::remove_file(&full).is_ok() {
                Some(m.clone())
            } else {
                None
            }
        }
        FsMutation::ModifyFile { rel_path, bytes } => {
            let full = root.join(rel_path);
            if !full.is_file() {
                return None;
            }
            // Append a sentinel byte to guarantee size change, sidestepping
            // mtime-granularity flakes on HFS+/older filesystems.
            let mut payload = bytes.clone();
            payload.push(b'X');
            if fs::write(&full, &payload).is_ok() {
                Some(FsMutation::ModifyFile {
                    rel_path: rel_path.clone(),
                    bytes: payload,
                })
            } else {
                None
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    /// For each real filesystem mutation applied after the snapshot, the
    /// event set produced by events_since contains at least one matching
    /// event for that path.
    #[test]
    fn events_since_reports_every_change(
        initial_tree in tree_shape(5..15),
        mutations in fs_mutation_sequence(0..10),
    ) {
        let td = TempDir::new().unwrap();
        let root = td.path().to_path_buf();

        // 1. Materialize the initial tree on disk.
        materialize(&root, &initial_tree).unwrap();

        // 2 + 3. Walk + populate + snapshot to disk (in a sibling location
        // outside the walk root so the snapshot file itself doesn't appear
        // as a filesystem entry).
        let snap_dir = TempDir::new().unwrap();
        let snap_path = snap_dir.path().join("snap.bin");
        let resume = snapshot_real_dir(&root, &snap_path);

        // 4. Apply mutations. Track which ones actually landed and what the
        // effective path was (so the assertion compares like-for-like).
        let mut applied: Vec<FsMutation> = Vec::new();
        for m in &mutations {
            if let Some(effective) = apply_mutation(&root, m) {
                applied.push(effective);
            }
        }

        // 5 + 6. Diff the snapshot against current disk state.
        let events = events_since(&resume).unwrap();

        // 7. Bucket events by absolute path → variants observed. events_since
        // is allowed to report more than the mutation set (mtime-side-effects
        // on parent dirs count as Modified), but must never miss.
        let mut appeared_paths: HashSet<PathBuf> = HashSet::new();
        let mut disappeared_paths: HashSet<PathBuf> = HashSet::new();
        let mut modified_paths: HashSet<PathBuf> = HashSet::new();
        for e in &events {
            match e {
                ResumeEvent::Appeared { path } => {
                    appeared_paths.insert(path.clone());
                }
                ResumeEvent::Disappeared { path } => {
                    disappeared_paths.insert(path.clone());
                }
                ResumeEvent::Modified { path } => {
                    modified_paths.insert(path.clone());
                }
                ResumeEvent::RootDisappeared { .. } => {
                    prop_assert!(false, "root should still exist: {:?}", e);
                }
            }
        }

        // For each applied mutation, verify the corresponding event exists.
        // Relaxations:
        //  * Create of a path that already existed pre-snapshot is observed
        //    as Modified, not Appeared.
        //  * Delete of a path that was created post-snapshot in a prior
        //    mutation nets out as neither Appeared nor Disappeared.
        // To keep the assertion precise, we reconstruct the final state the
        // on-disk tree should be in after `applied` and compare to the
        // pre-snapshot tree, then assert events match the diff.
        let mut pre_snapshot_files: HashSet<PathBuf> = initial_tree
            .files
            .iter()
            .map(|(p, _)| root.join(p))
            .collect();
        let mut current_files: HashSet<PathBuf> = pre_snapshot_files.clone();
        for m in &applied {
            match m {
                FsMutation::CreateFile { rel_path, .. } => {
                    current_files.insert(root.join(rel_path));
                }
                FsMutation::DeleteFile { rel_path } => {
                    current_files.remove(&root.join(rel_path));
                }
                FsMutation::ModifyFile { .. } => {
                    // No set membership change.
                }
            }
        }
        // Prune pre_snapshot_files of paths that point at a directory
        // on disk — materialize() dedup above means this won't happen, but
        // be defensive against future strategy changes.
        pre_snapshot_files.retain(|p| p.is_file() || !p.exists());

        // Expected Appeared: paths now on disk but not before.
        for p in current_files.difference(&pre_snapshot_files) {
            prop_assert!(
                appeared_paths.contains(p) || modified_paths.contains(p),
                "missing Appeared/Modified event for created path {:?}\nevents: {:?}",
                p, events
            );
        }
        // Expected Disappeared: paths before but not now.
        for p in pre_snapshot_files.difference(&current_files) {
            prop_assert!(
                disappeared_paths.contains(p),
                "missing Disappeared event for deleted path {:?}\nevents: {:?}",
                p, events
            );
        }
        // Expected Modified: any ModifyFile whose path still exists and
        // was in the pre-snapshot set.
        for m in &applied {
            if let FsMutation::ModifyFile { rel_path, .. } = m {
                let full = root.join(rel_path);
                if pre_snapshot_files.contains(&full) && current_files.contains(&full) {
                    prop_assert!(
                        modified_paths.contains(&full),
                        "missing Modified event for {:?}\nevents: {:?}",
                        full, events
                    );
                }
            }
        }
    }
}
