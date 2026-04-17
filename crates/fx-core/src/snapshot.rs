// Phase 1 commit 1.4: minimal stub; commit 1.5 expands to full children/roots/counts.
// Phase 2 swaps the BTreeMap for a SumTree<EntryNode> with O(log n) summaries.

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::entry::{Entry, EntryId};

#[derive(Clone, Default)]
pub struct StoreSnapshot {
    pub(crate) entries: BTreeMap<EntryId, Arc<Entry>>,
    pub(crate) tree_version: u64,
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
}
