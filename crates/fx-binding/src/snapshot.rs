//! MirrorSnapshot — JS-visible wrapper around `Arc<StoreSnapshot>`.
//!
//! SPEC §4.9: reads go through an immutable snapshot so the JS side can
//! use identity comparison (`===`) for concurrent-safe rendering. The
//! inner `Arc` is unchanged between deltas, so two `getSnapshot()` calls
//! between the same versions share an identity-equal inner pointer.
//!
//! Wave 2 surface: tree_version, decoration_version (stub), roots(),
//! get_by_id, direct_child_count, has_children. visible_rows /
//! visible_row_count land in wave 3 (commit 5.4). Decorations ship in
//! Phase 9.

use std::collections::HashSet;
use std::sync::Arc;

use napi_derive::napi;

use fx_core::{EntryId, StoreSnapshot};

use crate::types::{EntryJs, VisibleRowCountJs, VisibleRowJs};

/// Input shape for `MirrorSnapshot.visibleRows()`. Flat record so JS can pass
/// the expanded-id set + viewport window in one object. Sort options land in
/// Phase 9 (natural sort).
#[napi(object)]
pub struct VisibleRowsOptionsJs {
    pub expanded: Vec<i64>,
    pub offset: u32,
    pub limit: u32,
    pub include_ignored: Option<bool>,
}

/// Immutable snapshot of the tree at a specific tree-version.
#[napi]
pub struct MirrorSnapshot {
    pub(crate) inner: Arc<StoreSnapshot>,
}

#[napi]
impl MirrorSnapshot {
    /// Monotonic tree-version at the moment of capture.
    #[napi(getter, js_name = "treeVersion")]
    pub fn tree_version(&self) -> u32 {
        self.inner.tree_version() as u32
    }

    /// Decoration version. Phase 9 wires to a real counter; 0 until then.
    #[napi(getter, js_name = "decorationVersion")]
    pub fn decoration_version(&self) -> u32 {
        0
    }

    /// Workspace roots in the order they were registered.
    #[napi]
    pub fn roots(&self) -> Vec<EntryJs> {
        self.inner
            .roots()
            .iter()
            .filter_map(|id| self.inner.get(*id).map(|arc| EntryJs::from_core(arc.as_ref())))
            .collect()
    }

    /// Lookup an entry by id. Returns None if the id isn't in this snapshot.
    #[napi(js_name = "getById")]
    pub fn get_by_id(&self, id: i64) -> Option<EntryJs> {
        // i64→u64 is lossless for non-negative ids; negative ids never exist
        // (allocator caps at 2^53, well below i64::MAX) so out-of-range is
        // the caller's problem — they get None from the lookup anyway.
        let eid = EntryId(id as u64);
        self.inner.get(eid).map(|arc| EntryJs::from_core(arc.as_ref()))
    }

    /// Direct-child count for a directory id. None if the id isn't known
    /// or isn't a container.
    #[napi(js_name = "directChildCount")]
    pub fn direct_child_count(&self, id: i64) -> Option<u32> {
        let eid = EntryId(id as u64);
        self.inner.direct_child_count(eid)
    }

    /// True if the entry has at least one child visible in this snapshot.
    #[napi(js_name = "hasChildren")]
    pub fn has_children(&self, id: i64) -> bool {
        let eid = EntryId(id as u64);
        self.inner.has_children(eid)
    }

    /// Flattened viewport rows for the current expanded-set and window.
    /// `include_ignored` defaults to false, matching SPEC §4.9.2.
    #[napi(js_name = "visibleRows")]
    pub fn visible_rows(&self, options: VisibleRowsOptionsJs) -> Vec<VisibleRowJs> {
        let expanded: HashSet<EntryId> =
            options.expanded.iter().map(|id| EntryId(*id as u64)).collect();

        let query = fx_core::VisibleRowsQuery {
            expanded: &expanded,
            offset: options.offset,
            limit: options.limit,
            include_ignored: options.include_ignored.unwrap_or(false),
        };

        self.inner
            .visible_rows(query)
            .into_iter()
            .map(|row| VisibleRowJs::from_core_row(&row, self.inner.as_ref(), &expanded))
            .collect()
    }

    /// Honest scroll-height metric: `known` rows plus any expanded folders
    /// whose children haven't arrived yet (so the UI can render a loading
    /// badge without fudging offsets).
    #[napi(js_name = "visibleRowCount")]
    pub fn visible_row_count(
        &self,
        expanded: Vec<i64>,
        include_ignored: Option<bool>,
    ) -> VisibleRowCountJs {
        let expanded_set: HashSet<EntryId> =
            expanded.iter().map(|id| EntryId(*id as u64)).collect();

        let result = self
            .inner
            .visible_row_count(&expanded_set, include_ignored.unwrap_or(false));

        VisibleRowCountJs {
            known: result.known,
            pending_expansions: result
                .pending_expansions
                .into_iter()
                .map(|id| id.raw() as i64)
                .collect(),
        }
    }
}
