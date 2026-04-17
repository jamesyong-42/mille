// Phase 1 commit 1.5: StoreSnapshot now carries the children index, roots list,
// and direct_child_counts summary (SPEC §4.9.2 — the summary ships in every
// delta so visibleRowCount can answer honestly during expansion races).
//
// Children are stored sorted by name using raw byte order. Natural-sort is a
// Phase 9 concern (PLAN 13.9); byte order is adequate for unit tests today.
//
// Phase 2 swaps the BTreeMap + Vec<EntryId> slots for a SumTree<EntryNode> with
// O(log n) summary queries behind the same public API on this struct.

use std::collections::BTreeMap;
use std::sync::Arc;

use smallvec::SmallVec;

use crate::entry::{Entry, EntryId};

#[derive(Clone, Default)]
pub struct StoreSnapshot {
    pub(crate) entries: BTreeMap<EntryId, Arc<Entry>>,
    pub(crate) children: BTreeMap<EntryId, SmallVec<[EntryId; 8]>>,
    pub(crate) roots: SmallVec<[EntryId; 4]>,
    pub(crate) tree_version: u64,
    pub(crate) direct_child_counts: BTreeMap<EntryId, u32>,
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
}
