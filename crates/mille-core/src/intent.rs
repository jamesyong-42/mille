//! Mutation intent cache for watcher dedup (SPEC §4.4, PLAN 3.9).
//!
//! When the binding's `mutate()` path performs a filesystem change, it
//! records a MutationIntent. Shortly after, the OS watcher echoes the
//! same change back up to the coalescer. The coalescer calls
//! `consume()` before emitting; a matching entry suppresses the echo
//! so we don't double-count our own writes as external changes.
//!
//! `consume()` is single-shot per intent: two recorded deletes on the
//! same path suppress exactly two echoes, not a stream.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Default time a recorded intent is eligible to match an echo.
pub const DEFAULT_TTL: Duration = Duration::from_secs(2);

/// Hard cap on cache size. Large enough to absorb bursts of hundreds of
/// mutations per second within the default 2s TTL, small enough to keep
/// the linear scan cheap. Bounds memory regardless of caller sweep cadence.
pub const MAX_ENTRIES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IntentKind {
    Create,
    Modify,
    Delete,
    /// For renames, callers record TWO intents: Rename on `from` and
    /// Rename on `to`. The coalescer consumes whichever side the
    /// platform happens to surface.
    Rename,
}

#[derive(Clone, Debug)]
pub struct MutationIntent {
    pub path: PathBuf,
    pub kind: IntentKind,
    pub expires_at: Instant,
}

pub struct IntentCache {
    ttl: Duration,
    /// Entries are small in the steady state. Linear scan is fine and
    /// keeps the data structure trivially inspectable.
    entries: Vec<MutationIntent>,
}

impl IntentCache {
    pub fn new() -> Self {
        Self::with_ttl(DEFAULT_TTL)
    }

    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Vec::new(),
        }
    }

    /// Record that we just performed a mutation; expect a watcher echo
    /// within `ttl`. Stacks — two identical records require two consumes.
    ///
    /// If the cache is at `MAX_ENTRIES`, the oldest entry is dropped to
    /// bound memory regardless of caller sweep cadence.
    pub fn record(&mut self, path: PathBuf, kind: IntentKind, now: Instant) {
        if self.entries.len() >= MAX_ENTRIES {
            // Drop oldest. O(n) on Vec; migrate to VecDeque if this becomes hot.
            self.entries.remove(0);
        }
        self.entries.push(MutationIntent {
            path,
            kind,
            expires_at: now + self.ttl,
        });
    }

    /// True if a matching unexpired intent existed; consumes one on match.
    pub fn consume(&mut self, path: &Path, kind: IntentKind, now: Instant) -> bool {
        // Auto-sweep expired entries first so the scan window stays short
        // even if callers never invoke sweep() directly.
        self.sweep(now);
        // Find the oldest unexpired matching entry; remove it.
        let mut found = None;
        for (i, entry) in self.entries.iter().enumerate() {
            if entry.expires_at > now && entry.kind == kind && entry.path == path {
                found = Some(i);
                break;
            }
        }
        if let Some(i) = found {
            self.entries.remove(i);
            true
        } else {
            false
        }
    }

    /// Drop expired entries. Called periodically (e.g. per coalescer tick).
    pub fn sweep(&mut self, now: Instant) {
        self.entries.retain(|e| e.expires_at > now);
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl Default for IntentCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_records_and_consumes_matching_echo() {
        let mut c = IntentCache::new();
        let now = Instant::now();
        c.record(PathBuf::from("/a"), IntentKind::Create, now);
        assert!(c.consume(Path::new("/a"), IntentKind::Create, now));
    }

    #[test]
    fn cache_does_not_consume_non_matching_kind() {
        let mut c = IntentCache::new();
        let now = Instant::now();
        c.record(PathBuf::from("/a"), IntentKind::Create, now);
        assert!(!c.consume(Path::new("/a"), IntentKind::Delete, now));
        // Original entry still present for a correct-kind consume.
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn cache_does_not_consume_non_matching_path() {
        let mut c = IntentCache::new();
        let now = Instant::now();
        c.record(PathBuf::from("/a"), IntentKind::Create, now);
        assert!(!c.consume(Path::new("/b"), IntentKind::Create, now));
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn cache_consume_is_single_shot() {
        let mut c = IntentCache::new();
        let now = Instant::now();
        c.record(PathBuf::from("/a"), IntentKind::Delete, now);
        assert!(c.consume(Path::new("/a"), IntentKind::Delete, now));
        assert!(!c.consume(Path::new("/a"), IntentKind::Delete, now));
        assert_eq!(c.len(), 0);
    }

    #[test]
    fn cache_stacks_multiple_intents_on_same_path() {
        let mut c = IntentCache::new();
        let now = Instant::now();
        c.record(PathBuf::from("/a"), IntentKind::Delete, now);
        c.record(PathBuf::from("/a"), IntentKind::Delete, now);
        assert_eq!(c.len(), 2);
        assert!(c.consume(Path::new("/a"), IntentKind::Delete, now));
        assert!(c.consume(Path::new("/a"), IntentKind::Delete, now));
        assert!(!c.consume(Path::new("/a"), IntentKind::Delete, now));
    }

    #[test]
    fn cache_expires_after_ttl() {
        let mut c = IntentCache::with_ttl(Duration::from_millis(500));
        let now = Instant::now();
        c.record(PathBuf::from("/a"), IntentKind::Modify, now);
        // Past TTL — consume must miss.
        let later = now + Duration::from_secs(1);
        assert!(!c.consume(Path::new("/a"), IntentKind::Modify, later));
    }

    #[test]
    fn cache_sweep_removes_expired_entries() {
        let mut c = IntentCache::with_ttl(Duration::from_millis(500));
        let now = Instant::now();
        c.record(PathBuf::from("/a"), IntentKind::Modify, now);
        c.record(
            PathBuf::from("/b"),
            IntentKind::Modify,
            now + Duration::from_secs(2),
        );
        let later = now + Duration::from_secs(1);
        c.sweep(later);
        // /a expired at now+0.5s, should be gone; /b expires at now+2.5s, kept.
        assert_eq!(c.len(), 1);
        assert!(!c.consume(Path::new("/a"), IntentKind::Modify, later));
        assert!(c.consume(Path::new("/b"), IntentKind::Modify, later));
    }

    #[test]
    fn cache_bounded_at_max_entries() {
        let mut c = IntentCache::new();
        let now = Instant::now();
        for i in 0..5000 {
            c.record(PathBuf::from(format!("/p{}", i)), IntentKind::Create, now);
        }
        assert_eq!(c.len(), MAX_ENTRIES);
    }

    #[test]
    fn cache_drops_oldest_when_at_cap() {
        let mut c = IntentCache::new();
        let now = Instant::now();
        // Fill to cap with distinguishable paths.
        for i in 0..MAX_ENTRIES {
            c.record(PathBuf::from(format!("/p{}", i)), IntentKind::Create, now);
        }
        assert_eq!(c.len(), MAX_ENTRIES);
        // One more push — oldest ("/p0") should be evicted.
        let newest = PathBuf::from("/newest");
        c.record(newest.clone(), IntentKind::Create, now);
        assert_eq!(c.len(), MAX_ENTRIES);
        // Oldest gone.
        assert!(!c.consume(Path::new("/p0"), IntentKind::Create, now));
        // Newest still present.
        assert!(c.consume(&newest, IntentKind::Create, now));
    }

    #[test]
    fn cache_consume_auto_sweeps() {
        let mut c = IntentCache::with_ttl(Duration::from_secs(1));
        let now = Instant::now();
        c.record(PathBuf::from("/a"), IntentKind::Create, now);
        c.record(PathBuf::from("/b"), IntentKind::Create, now);
        c.record(PathBuf::from("/c"), IntentKind::Create, now);
        assert_eq!(c.len(), 3);
        let later = now + Duration::from_secs(2);
        // Non-matching path at t=2s — entries all expired, auto-sweep clears them.
        assert!(!c.consume(Path::new("/nope"), IntentKind::Create, later));
        assert_eq!(c.len(), 0);
        // Matching path, now expired — still false; len remains 0.
        assert!(!c.consume(Path::new("/a"), IntentKind::Create, later));
        assert_eq!(c.len(), 0);
    }

    #[test]
    fn cache_rename_kind_matches() {
        let mut c = IntentCache::new();
        let now = Instant::now();
        c.record(PathBuf::from("/from"), IntentKind::Rename, now);
        c.record(PathBuf::from("/to"), IntentKind::Rename, now);
        assert!(c.consume(Path::new("/from"), IntentKind::Rename, now));
        assert!(c.consume(Path::new("/to"), IntentKind::Rename, now));
        assert!(c.is_empty());
    }
}
