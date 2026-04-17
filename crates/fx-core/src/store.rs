// EntryStore: the canonical in-memory tree state.
//
// Readers grab a lock-free Arc<StoreSnapshot> via ArcSwap::load.
// Writers serialize on a parking_lot Mutex while cloning+publishing
// the next snapshot, so insert/remove can't lose updates under contention.
//
// Phase 1 keeps StoreSnapshot's entry map flat (BTreeMap); Phase 2 swaps in
// a SumTree<EntryNode> behind the same API for O(log n) summary queries.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use arc_swap::ArcSwap;
use dashmap::DashMap;
use parking_lot::Mutex;

use crate::entry::{Entry, EntryId, EntryKind};
use crate::error::FxError;
use crate::snapshot::StoreSnapshot;

pub struct EntryStore {
    inner: ArcSwap<StoreSnapshot>,
    path_to_id: DashMap<PathBuf, EntryId>,
    id_counter: AtomicU64,
    write_lock: Mutex<()>,
}

impl EntryStore {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::new(Arc::new(StoreSnapshot::empty())),
            path_to_id: DashMap::new(),
            id_counter: AtomicU64::new(0),
            write_lock: Mutex::new(()),
        }
    }

    pub fn snapshot(&self) -> Arc<StoreSnapshot> {
        self.inner.load_full()
    }

    pub fn tree_version(&self) -> u64 {
        self.inner.load().tree_version
    }

    pub fn get_by_id(&self, id: EntryId) -> Option<Arc<Entry>> {
        self.inner.load().entries.get(&id).cloned()
    }

    pub fn get_by_path(&self, path: &Path) -> Option<Arc<Entry>> {
        let id = *self.path_to_id.get(path)?.value();
        self.get_by_id(id)
    }

    pub fn insert(&self, path: PathBuf, mut entry: Entry) -> Result<EntryId, FxError> {
        let _guard = self.write_lock.lock();
        let id = EntryId::alloc_from(&self.id_counter)?;
        entry.id = id;

        let current = self.inner.load_full();
        let mut next = (*current).clone();
        next.entries.insert(id, Arc::new(entry));
        next.tree_version += 1;
        self.inner.store(Arc::new(next));

        self.path_to_id.insert(path, id);
        Ok(id)
    }

    pub fn remove(&self, id: EntryId) -> Option<Arc<Entry>> {
        let _guard = self.write_lock.lock();
        let current = self.inner.load_full();
        if !current.entries.contains_key(&id) {
            return None;
        }
        let mut next = (*current).clone();
        let removed = next.entries.remove(&id)?;
        next.tree_version += 1;
        self.inner.store(Arc::new(next));

        // O(n) in path count — acceptable for Phase 1; reverse index lands in Phase 2.
        let path_to_remove = self
            .path_to_id
            .iter()
            .find(|kv| *kv.value() == id)
            .map(|kv| kv.key().clone());
        if let Some(p) = path_to_remove {
            self.path_to_id.remove(&p);
        }
        Some(removed)
    }

    pub fn rename(&self, id: EntryId, new_path: PathBuf) -> Result<(), FxError> {
        let _guard = self.write_lock.lock();
        let entry = self
            .inner
            .load()
            .entries
            .get(&id)
            .cloned()
            .ok_or_else(|| FxError::InvalidInput(format!("entry {:?} not found", id)))?;

        if entry.kind == EntryKind::Directory {
            return Err(FxError::Unsupported(
                "recursive directory rename deferred to Phase 2 walker".into(),
            ));
        }

        let old_path = self
            .path_to_id
            .iter()
            .find(|kv| *kv.value() == id)
            .map(|kv| kv.key().clone());
        if let Some(p) = old_path {
            self.path_to_id.remove(&p);
        }
        self.path_to_id.insert(new_path, id);

        let current = self.inner.load_full();
        let mut next = (*current).clone();
        next.tree_version += 1;
        self.inner.store(Arc::new(next));
        Ok(())
    }

    // Test-only: force the id counter near overflow so the cap can be exercised.
    #[cfg(any(test, feature = "test-util"))]
    pub fn __set_counter_for_tests(&self, value: u64) {
        self.id_counter.store(value, Ordering::Relaxed);
    }
}

impl Default for EntryStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry::{Entry, EntryKind};

    fn leaf(name: &str, parent: Option<EntryId>) -> Entry {
        Entry {
            id: EntryId(0),
            parent_id: parent,
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

    fn dir(name: &str, parent: Option<EntryId>) -> Entry {
        Entry {
            kind: EntryKind::Directory,
            ..leaf(name, parent)
        }
    }

    #[test]
    fn empty_store_has_version_zero() {
        let s = EntryStore::new();
        assert_eq!(s.tree_version(), 0);
        assert_eq!(s.snapshot().entry_count(), 0);
    }

    #[test]
    fn insert_roundtrip_by_id_and_path() {
        let s = EntryStore::new();
        let id = s.insert("/a".into(), leaf("a", None)).unwrap();
        assert!(s.get_by_id(id).is_some());
        assert_eq!(s.get_by_path(Path::new("/a")).map(|e| e.id), Some(id));
    }

    #[test]
    fn insert_advances_tree_version() {
        let s = EntryStore::new();
        assert_eq!(s.tree_version(), 0);
        s.insert("/a".into(), leaf("a", None)).unwrap();
        assert_eq!(s.tree_version(), 1);
        s.insert("/b".into(), leaf("b", None)).unwrap();
        assert_eq!(s.tree_version(), 2);
    }

    #[test]
    fn two_inserts_allocate_distinct_ids() {
        let s = EntryStore::new();
        let a = s.insert("/a".into(), leaf("a", None)).unwrap();
        let b = s.insert("/b".into(), leaf("b", None)).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn remove_returns_some_then_none() {
        let s = EntryStore::new();
        let id = s.insert("/a".into(), leaf("a", None)).unwrap();
        assert!(s.remove(id).is_some());
        assert!(s.remove(id).is_none());
        assert!(s.get_by_id(id).is_none());
        assert!(s.get_by_path(Path::new("/a")).is_none());
    }

    #[test]
    fn rename_leaf_updates_path_mapping() {
        let s = EntryStore::new();
        let id = s.insert("/a".into(), leaf("a", None)).unwrap();
        s.rename(id, "/b".into()).unwrap();
        assert!(s.get_by_path(Path::new("/a")).is_none());
        assert_eq!(s.get_by_path(Path::new("/b")).map(|e| e.id), Some(id));
    }

    #[test]
    fn rename_directory_is_unsupported_in_phase1() {
        let s = EntryStore::new();
        let id = s.insert("/d".into(), dir("d", None)).unwrap();
        let err = s.rename(id, "/e".into()).unwrap_err();
        assert_eq!(err.code(), crate::error::ErrorCode::EUNSUPPORTED);
    }

    #[test]
    fn rename_missing_id_is_invalid_input() {
        let s = EntryStore::new();
        let err = s
            .rename(EntryId(42), "/x".into())
            .unwrap_err();
        assert_eq!(err.code(), crate::error::ErrorCode::EINVAL);
    }

    #[test]
    fn concurrent_inserts_yield_distinct_ids() {
        use std::collections::HashSet;
        let s = Arc::new(EntryStore::new());
        const THREADS: usize = 4;
        const PER_THREAD: usize = 1000;

        let mut handles = Vec::new();
        for t in 0..THREADS {
            let s = s.clone();
            handles.push(std::thread::spawn(move || {
                let mut ids = Vec::with_capacity(PER_THREAD);
                for i in 0..PER_THREAD {
                    let path: PathBuf = format!("/t{}/f{}", t, i).into();
                    let id = s.insert(path, leaf(&format!("f{}", i), None)).unwrap();
                    ids.push(id);
                }
                ids
            }));
        }

        let mut all = HashSet::new();
        for h in handles {
            for id in h.join().unwrap() {
                assert!(all.insert(id), "duplicate id allocated under contention");
            }
        }
        assert_eq!(all.len(), THREADS * PER_THREAD);
        assert_eq!(s.snapshot().entry_count(), THREADS * PER_THREAD);
    }

    #[test]
    fn counter_near_max_hits_entryid_exhausted() {
        let s = EntryStore::new();
        s.__set_counter_for_tests((1u64 << 53) - 1);
        assert!(s.insert("/last".into(), leaf("last", None)).is_ok());
        let err = s.insert("/past".into(), leaf("past", None)).unwrap_err();
        assert!(matches!(err, FxError::EntryIdExhausted));
    }
}
