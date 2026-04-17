// Compact-folders computation (Phase 2.6).
//
// When a directory has exactly one child and that child is also a directory,
// the UI collapses the chain into a single row. Per SPEC §9 resolution 2,
// the compact row carries the LEAF's EntryId with `path_segments` listing
// the whole chain (e.g. `["a", "b", "c"]` for a/b/c).
//
// This module computes:
//   - compact_chain_for(snap, id) — if `id` begins a compact chain, returns
//     the leaf id and the ordered segments. Otherwise None.
//   - is_compacted_intermediate(snap, id) — true if `id` is in the middle
//     of a chain and should be suppressed from compact rendering.
//
// Visible_rows integration happens in Phase 5/8 where the viewport query
// knows whether to render compact rows or flat.

use crate::entry::{EntryId, EntryKind};
use crate::snapshot::StoreSnapshot;

/// Max chain length we'll follow. Defense against pathological trees.
const MAX_CHAIN_DEPTH: usize = 256;

/// If `id` begins a compact chain — i.e. its parent has multiple children (or
/// it's a root), AND it's itself a directory with exactly one child that is
/// also a directory with exactly one child, ... — returns the leaf id plus
/// the ordered `path_segments` for that chain.
///
/// Returns `None` when `id` is not a chain head (either already inside one,
/// or it's a leaf/branch that doesn't compress).
pub fn compact_chain_for(snap: &StoreSnapshot, id: EntryId) -> Option<(EntryId, Vec<String>)> {
    if is_compacted_intermediate(snap, id) {
        return None;
    }

    let start = snap.get(id)?;
    if start.kind != EntryKind::Directory {
        return None;
    }

    let mut segments = vec![start.name.clone()];
    let mut leaf = id;
    let mut hops = 0usize;

    loop {
        hops += 1;
        if hops >= MAX_CHAIN_DEPTH {
            break;
        }

        let children = snap.children_of(leaf);
        if children.len() != 1 {
            break;
        }
        let only_child = children[0];
        let child_entry = match snap.get(only_child) {
            Some(e) => e,
            None => break,
        };
        if child_entry.kind != EntryKind::Directory {
            break;
        }
        segments.push(child_entry.name.clone());
        leaf = only_child;
    }

    // If the chain is exactly length 1, nothing to compact — the UI would
    // render the row as a normal single entry.
    if segments.len() <= 1 {
        return None;
    }

    Some((leaf, segments))
}

/// True when `id` sits in the interior of a compact chain and should be
/// suppressed from compact rendering. Walks up through single-child-dir
/// ancestors; if we arrive at a chain-head ancestor that isn't `id` itself,
/// `id` is in the middle of a chain.
pub fn is_compacted_intermediate(snap: &StoreSnapshot, id: EntryId) -> bool {
    let entry = match snap.get(id) {
        Some(e) => e,
        None => return false,
    };
    if entry.kind != EntryKind::Directory {
        return false;
    }

    let mut current_id = id;
    let mut hops = 0usize;
    loop {
        hops += 1;
        if hops >= MAX_CHAIN_DEPTH {
            return false;
        }
        let cur = match snap.get(current_id) {
            Some(e) => e,
            None => return false,
        };
        let parent_id = match cur.parent_id {
            Some(p) => p,
            None => return id != current_id,
        };
        let parent_siblings = snap.children_of(parent_id);
        if parent_siblings.len() != 1 {
            return id != current_id;
        }
        current_id = parent_id;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry::{Entry, EntryId, EntryKind};
    use crate::store::EntryStore;
    use std::path::PathBuf;

    fn dir(name: &str, parent: Option<EntryId>) -> Entry {
        Entry {
            id: EntryId(0),
            parent_id: parent,
            name: name.into(),
            kind: EntryKind::Directory,
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

    fn leaf(name: &str, parent: Option<EntryId>) -> Entry {
        Entry {
            kind: EntryKind::File,
            ..dir(name, parent)
        }
    }

    fn build_chain() -> (EntryStore, EntryId, EntryId, EntryId, EntryId) {
        let s = EntryStore::new();
        let a = s.insert(PathBuf::from("/a"), dir("a", None)).unwrap();
        let b = s.insert(PathBuf::from("/a/b"), dir("b", Some(a))).unwrap();
        let c = s.insert(PathBuf::from("/a/b/c"), dir("c", Some(b))).unwrap();
        let f = s
            .insert(PathBuf::from("/a/b/c/d.txt"), leaf("d.txt", Some(c)))
            .unwrap();
        (s, a, b, c, f)
    }

    #[test]
    fn single_chain_compacts_to_leaf_dir() {
        let (s, a, b, c, _f) = build_chain();
        let snap = s.snapshot();
        let (leaf_id, segments) = compact_chain_for(&snap, a).expect("chain");
        assert_eq!(leaf_id, c);
        assert_eq!(segments, vec!["a", "b", "c"]);
        assert!(!is_compacted_intermediate(&snap, a));
        assert!(is_compacted_intermediate(&snap, b));
        assert!(is_compacted_intermediate(&snap, c));
    }

    #[test]
    fn branch_stops_the_chain() {
        let s = EntryStore::new();
        let a = s.insert(PathBuf::from("/a"), dir("a", None)).unwrap();
        let b = s.insert(PathBuf::from("/a/b"), dir("b", Some(a))).unwrap();
        let _c1 = s
            .insert(PathBuf::from("/a/b/c1"), dir("c1", Some(b)))
            .unwrap();
        let _c2 = s
            .insert(PathBuf::from("/a/b/c2"), dir("c2", Some(b)))
            .unwrap();

        let snap = s.snapshot();
        let (leaf_id, segments) = compact_chain_for(&snap, a).expect("chain up to b");
        assert_eq!(leaf_id, b);
        assert_eq!(segments, vec!["a", "b"]);
    }

    #[test]
    fn no_chain_for_single_directory_with_file_child() {
        let s = EntryStore::new();
        let a = s.insert(PathBuf::from("/a"), dir("a", None)).unwrap();
        let _f = s
            .insert(PathBuf::from("/a/x.txt"), leaf("x.txt", Some(a)))
            .unwrap();
        let snap = s.snapshot();
        assert!(compact_chain_for(&snap, a).is_none());
    }

    #[test]
    fn no_chain_for_file_entry() {
        let s = EntryStore::new();
        let f = s.insert(PathBuf::from("/f"), leaf("f", None)).unwrap();
        let snap = s.snapshot();
        assert!(compact_chain_for(&snap, f).is_none());
    }

    #[test]
    fn intermediate_entries_report_correctly() {
        let (_s, a, b, c, f) = build_chain();
        let snap = _s.snapshot();
        assert!(!is_compacted_intermediate(&snap, a));
        assert!(is_compacted_intermediate(&snap, b));
        assert!(is_compacted_intermediate(&snap, c));
        assert!(!is_compacted_intermediate(&snap, f));
    }

    #[test]
    fn compact_chain_on_unknown_id_returns_none() {
        let s = EntryStore::new();
        let snap = s.snapshot();
        assert!(compact_chain_for(&snap, EntryId(999)).is_none());
    }
}
