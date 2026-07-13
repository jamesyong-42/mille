// ChangeSet: accumulates structural mutations between snapshot publications.
//
// Phase 7's per-session delta diff consumes one ChangeSet per coalescer tick
// and intersects it with each session's expanded-folder set. That turns the
// cross product (sessions × expanded × changed) into an index lookup per
// session (O(changed) + O(|expanded ∩ changed|)).
//
// SPEC §4.9.9 "Delta diff is indexed, not quadratic".

use std::collections::{HashMap, HashSet};

use crate::entry::EntryId;

/// Accumulates structural changes between snapshot publications. The
/// coalescer consumes one ChangeSet per tick and intersects it with each
/// session's expanded set to produce per-session deltas.
#[derive(Clone, Debug, Default)]
pub struct ChangeSet {
    /// Ids whose entry record changed (created, modified, or deleted).
    pub changed_ids: HashSet<EntryId>,
    /// Ids whose parent changed. Populated by rename and cross-dir move.
    /// Maps id -> (old_parent_id, new_parent_id). Either may be None for
    /// root transitions. For Phase 4 (leaf rename only), this is empty.
    pub reparented_ids: HashMap<EntryId, (Option<EntryId>, Option<EntryId>)>,
    /// Subtree roots whose descendant counts / sizes changed. Derived from
    /// the ancestor-walk in insert/remove. This is what sessions index
    /// against — each session checks `expanded ∩ subtree_roots_changed`.
    pub subtree_roots_changed: HashSet<EntryId>,
    /// Folders whose direct-children list changed. Distinct from
    /// subtree_roots_changed, which fires for any descendant summary change.
    /// Phase 7 uses this to decide which expanded folders need their
    /// child-list re-sent; subtree_roots_changed drives row-count refresh.
    pub child_set_changed: HashSet<EntryId>,
    /// Tree version BEFORE the changes landed.
    pub from_version: u64,
    /// Tree version AFTER the changes landed (the current one).
    pub to_version: u64,
}

impl ChangeSet {
    pub fn is_empty(&self) -> bool {
        self.changed_ids.is_empty()
            && self.reparented_ids.is_empty()
            && self.subtree_roots_changed.is_empty()
            && self.child_set_changed.is_empty()
    }

    pub fn len(&self) -> usize {
        self.changed_ids.len()
    }

    /// Merge another ChangeSet into this one. Used to coalesce multiple
    /// mutations into a single delta per coalescer tick. Version range
    /// expands to cover both sides: `from` = min, `to` = max.
    pub fn merge(&mut self, other: ChangeSet) {
        self.changed_ids.extend(other.changed_ids);
        self.reparented_ids.extend(other.reparented_ids);
        self.subtree_roots_changed
            .extend(other.subtree_roots_changed);
        self.child_set_changed.extend(other.child_set_changed);
        // Version bookends: preserve earliest `from` and latest `to`. A zero
        // `from_version` on either side means "unset" — take the non-zero one.
        if self.from_version == 0
            || (other.from_version != 0 && other.from_version < self.from_version)
        {
            self.from_version = other.from_version;
        }
        if other.to_version > self.to_version {
            self.to_version = other.to_version;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changeset_is_empty_by_default() {
        let c = ChangeSet::default();
        assert!(c.is_empty());
        assert_eq!(c.len(), 0);
        assert_eq!(c.from_version, 0);
        assert_eq!(c.to_version, 0);
    }

    #[test]
    fn merge_unions_child_set_changed() {
        let mut a = ChangeSet::default();
        a.child_set_changed.insert(EntryId(100));
        let mut b = ChangeSet::default();
        b.child_set_changed.insert(EntryId(101));
        b.child_set_changed.insert(EntryId(100));
        a.merge(b);
        assert_eq!(a.child_set_changed.len(), 2);
        assert!(a.child_set_changed.contains(&EntryId(100)));
        assert!(a.child_set_changed.contains(&EntryId(101)));
    }

    #[test]
    fn merge_combines_both_sides() {
        let mut a = ChangeSet::default();
        a.changed_ids.insert(EntryId(1));
        a.subtree_roots_changed.insert(EntryId(10));
        a.from_version = 5;
        a.to_version = 7;

        let mut b = ChangeSet::default();
        b.changed_ids.insert(EntryId(2));
        b.subtree_roots_changed.insert(EntryId(11));
        b.reparented_ids
            .insert(EntryId(3), (Some(EntryId(20)), Some(EntryId(21))));
        b.from_version = 7;
        b.to_version = 9;

        a.merge(b);
        assert!(a.changed_ids.contains(&EntryId(1)));
        assert!(a.changed_ids.contains(&EntryId(2)));
        assert!(a.subtree_roots_changed.contains(&EntryId(10)));
        assert!(a.subtree_roots_changed.contains(&EntryId(11)));
        assert!(a.reparented_ids.contains_key(&EntryId(3)));
        assert_eq!(a.from_version, 5);
        assert_eq!(a.to_version, 9);
    }
}
