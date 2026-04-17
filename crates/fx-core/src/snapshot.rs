// Phase 1 commit 1.5: StoreSnapshot now carries the children index, roots list,
// and direct_child_counts summary (SPEC §4.9.2 — the summary ships in every
// delta so visibleRowCount can answer honestly during expansion races).
//
// Children are stored sorted by name using raw byte order. Natural-sort is a
// Phase 9 concern (PLAN 13.9); byte order is adequate for unit tests today.
//
// Phase 2 commit 2.1: augments the BTreeMap storage with descendant-summary
// caches (descendant_visible_counts, descendant_total_sizes) maintained by
// ancestor-walks in EntryStore insert/remove. A full Zed-style SumTree port
// is deferred to Phase 12 behind the same public query API.

use std::collections::BTreeMap;
use std::sync::Arc;

use smallvec::SmallVec;

use crate::entry::{Entry, EntryId};

/// Max ancestor hops in any summary update — defends against malformed
/// parent_id cycles (self-reference, etc.). Real trees are ~10-15 deep.
pub(crate) const MAX_ANCESTOR_WALK: usize = 128;

#[derive(Clone, Default)]
pub struct StoreSnapshot {
    pub(crate) entries: BTreeMap<EntryId, Arc<Entry>>,
    pub(crate) children: BTreeMap<EntryId, SmallVec<[EntryId; 8]>>,
    pub(crate) roots: SmallVec<[EntryId; 4]>,
    pub(crate) tree_version: u64,
    pub(crate) direct_child_counts: BTreeMap<EntryId, u32>,
    /// Count of visible (non-ignored, non-hidden) entries in the subtree rooted at
    /// this id, INCLUDING the root itself. A leaf has count 1 if visible.
    pub(crate) descendant_visible_counts: BTreeMap<EntryId, u32>,
    /// Sum of file sizes in the subtree (dirs contribute 0; files their `size`).
    pub(crate) descendant_total_sizes: BTreeMap<EntryId, u64>,
}

impl StoreSnapshot {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    pub fn tree_version(&self) -> u64 {
        self.tree_version
    }

    pub fn get(&self, id: EntryId) -> Option<&Arc<Entry>> {
        self.entries.get(&id)
    }

    pub fn roots(&self) -> &[EntryId] {
        &self.roots
    }

    pub fn children_of(&self, id: EntryId) -> &[EntryId] {
        self.children.get(&id).map(|v| v.as_slice()).unwrap_or(&[])
    }

    pub fn direct_child_count(&self, id: EntryId) -> Option<u32> {
        self.direct_child_counts.get(&id).copied()
    }

    pub fn has_children(&self, id: EntryId) -> bool {
        self.children.get(&id).is_some_and(|v| !v.is_empty())
    }

    /// Visible-descendant count for the subtree rooted at `id` (inclusive).
    /// Returns 0 for unknown ids so callers can blindly sum.
    pub fn subtree_visible_count(&self, id: EntryId) -> u32 {
        self.descendant_visible_counts.get(&id).copied().unwrap_or(0)
    }

    /// Total byte size of files in the subtree rooted at `id` (inclusive).
    /// Returns 0 for unknown ids.
    pub fn subtree_total_size(&self, id: EntryId) -> u64 {
        self.descendant_total_sizes.get(&id).copied().unwrap_or(0)
    }
}

/// Whether an entry contributes to the visible-row count (SPEC §4.9.2: ignored
/// and hidden entries are filtered out by default).
pub(crate) fn entry_counts_visible(entry: &Entry) -> bool {
    !entry.is_ignored && !entry.is_hidden
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry::{Entry, EntryKind};

    fn mk_entry(
        id: EntryId,
        parent: Option<EntryId>,
        name: &str,
        kind: EntryKind,
        size: u64,
        ignored: bool,
        hidden: bool,
    ) -> Entry {
        Entry {
            id,
            parent_id: parent,
            name: name.into(),
            kind,
            size,
            mtime_ms: 0,
            ctime_ms: 0,
            symlink_target_is_dir: None,
            path_segments: None,
            is_ignored: ignored,
            is_readonly: false,
            is_hidden: hidden,
        }
    }

    /// Directly seed a snapshot mirroring the EntryStore::insert summary logic.
    /// Local to the unit tests; store-level coverage lives in store.rs.
    fn seed(
        snap: &mut StoreSnapshot,
        id: EntryId,
        parent: Option<EntryId>,
        name: &str,
        kind: EntryKind,
        size: u64,
        ignored: bool,
        hidden: bool,
    ) {
        let entry = mk_entry(id, parent, name, kind, size, ignored, hidden);
        let visible = entry_counts_visible(&entry);
        snap.entries.insert(id, Arc::new(entry));
        match parent {
            None => snap.roots.push(id),
            Some(p) => {
                snap.children.entry(p).or_default().push(id);
                *snap.direct_child_counts.entry(p).or_insert(0) += 1;
            }
        }
        snap.descendant_visible_counts.insert(id, visible as u32);
        snap.descendant_total_sizes.insert(id, size);

        // Ancestor-walk mirroring EntryStore::insert.
        let mut cur = parent;
        let mut hops = 0;
        while let Some(a) = cur {
            if hops >= MAX_ANCESTOR_WALK {
                break;
            }
            if visible {
                *snap.descendant_visible_counts.entry(a).or_insert(0) += 1;
            }
            *snap.descendant_total_sizes.entry(a).or_insert(0) += size;
            cur = snap.entries.get(&a).and_then(|e| e.parent_id);
            hops += 1;
        }
    }

    #[test]
    fn subtree_visible_count_unknown_id_is_zero() {
        let snap = StoreSnapshot::empty();
        assert_eq!(snap.subtree_visible_count(EntryId(99)), 0);
        assert_eq!(snap.subtree_total_size(EntryId(99)), 0);
    }

    #[test]
    fn single_visible_leaf_counts_one() {
        let mut snap = StoreSnapshot::empty();
        let id = EntryId(1);
        seed(&mut snap, id, None, "a", EntryKind::File, 42, false, false);
        assert_eq!(snap.subtree_visible_count(id), 1);
        assert_eq!(snap.subtree_total_size(id), 42);
    }

    #[test]
    fn ignored_leaf_zero_count_but_size_still_summed() {
        let mut snap = StoreSnapshot::empty();
        let id = EntryId(1);
        seed(&mut snap, id, None, "a", EntryKind::File, 100, true, false);
        assert_eq!(snap.subtree_visible_count(id), 0);
        assert_eq!(snap.subtree_total_size(id), 100);
    }

    #[test]
    fn hidden_leaf_zero_count_but_size_still_summed() {
        let mut snap = StoreSnapshot::empty();
        let id = EntryId(1);
        seed(&mut snap, id, None, "a", EntryKind::File, 7, false, true);
        assert_eq!(snap.subtree_visible_count(id), 0);
        assert_eq!(snap.subtree_total_size(id), 7);
    }

    #[test]
    fn chain_a_b_c_all_visible_accumulates_up_the_chain() {
        let mut snap = StoreSnapshot::empty();
        let a = EntryId(1);
        let b = EntryId(2);
        let c = EntryId(3);
        seed(&mut snap, a, None, "a", EntryKind::Directory, 0, false, false);
        seed(&mut snap, b, Some(a), "b", EntryKind::Directory, 0, false, false);
        seed(&mut snap, c, Some(b), "c", EntryKind::File, 50, false, false);
        assert_eq!(snap.subtree_visible_count(a), 3);
        assert_eq!(snap.subtree_visible_count(b), 2);
        assert_eq!(snap.subtree_visible_count(c), 1);
        assert_eq!(snap.subtree_total_size(a), 50);
        assert_eq!(snap.subtree_total_size(b), 50);
        assert_eq!(snap.subtree_total_size(c), 50);
    }

    #[test]
    fn two_files_under_same_dir_sum_sizes() {
        let mut snap = StoreSnapshot::empty();
        let d = EntryId(1);
        let f1 = EntryId(2);
        let f2 = EntryId(3);
        seed(&mut snap, d, None, "d", EntryKind::Directory, 0, false, false);
        seed(&mut snap, f1, Some(d), "f1", EntryKind::File, 100, false, false);
        seed(&mut snap, f2, Some(d), "f2", EntryKind::File, 200, false, false);
        assert_eq!(snap.subtree_total_size(d), 300);
        assert_eq!(snap.subtree_visible_count(d), 3);
    }
}
