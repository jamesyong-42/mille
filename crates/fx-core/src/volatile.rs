//! Volatile-subtree detection and throttling (SPEC §4.4, PLAN 3.7).
//!
//! A pure state machine. The caller drives it with its own clock:
//!   - `record(dir, now)` per incoming event
//!   - `is_volatile(dir)` to query (e.g. in the coalescer)
//!   - `flush(now)` periodically to release cooled-down dirs
//!
//! When a directory exceeds `threshold` events within `window`, it flips
//! to volatile. It stays volatile until `cooldown` has elapsed since the
//! last breach (i.e. last recorded event on that dir).
//!
//! Phase 5 will wire this between the coalescer and NAPI delivery so
//! that storms (npm install, webpack builds) collapse into a single
//! `subtreeDirty: path` marker instead of thousands of individual events.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Default events-per-second rate above which a directory is volatile.
pub const DEFAULT_THRESHOLD: u32 = 200;
/// Default sliding window over which events are counted.
pub const DEFAULT_WINDOW: Duration = Duration::from_secs(1);
/// Default cooldown after last breach before release.
pub const DEFAULT_COOLDOWN: Duration = Duration::from_secs(2);

pub struct VolatileTracker {
    threshold: u32,
    window: Duration,
    cooldown: Duration,
    /// Per-directory sliding-window sample. Capped at threshold*2 to keep
    /// memory bounded under storms.
    activity: HashMap<PathBuf, VecDeque<Instant>>,
    /// When each dir first flipped to volatile. Removed on release.
    volatile_since: HashMap<PathBuf, Instant>,
    /// Last recorded event on a currently-volatile dir (breach timestamp).
    last_breach: HashMap<PathBuf, Instant>,
}

impl VolatileTracker {
    pub fn new() -> Self {
        Self::with_config(DEFAULT_THRESHOLD, DEFAULT_WINDOW, DEFAULT_COOLDOWN)
    }

    pub fn with_config(threshold: u32, window: Duration, cooldown: Duration) -> Self {
        Self {
            threshold,
            window,
            cooldown,
            activity: HashMap::new(),
            volatile_since: HashMap::new(),
            last_breach: HashMap::new(),
        }
    }

    /// Record an event touching `dir`. Flips dir to volatile if it now
    /// exceeds threshold within `window`.
    pub fn record(&mut self, dir: &Path, now: Instant) {
        let cap = (self.threshold as usize).saturating_mul(2).max(4);
        let samples = self
            .activity
            .entry(dir.to_path_buf())
            .or_insert_with(VecDeque::new);

        // Drop stale samples outside the sliding window.
        let cutoff = now.checked_sub(self.window);
        if let Some(cutoff) = cutoff {
            while let Some(front) = samples.front() {
                if *front < cutoff {
                    samples.pop_front();
                } else {
                    break;
                }
            }
        }

        samples.push_back(now);
        // Keep memory bounded under sustained storms.
        while samples.len() > cap {
            samples.pop_front();
        }

        if samples.len() as u32 > self.threshold {
            // Flip to volatile on breach; update last_breach on continued breach.
            self.volatile_since
                .entry(dir.to_path_buf())
                .or_insert(now);
            self.last_breach.insert(dir.to_path_buf(), now);
        } else if self.volatile_since.contains_key(dir) {
            // Still volatile (not yet released via flush) — refresh breach.
            self.last_breach.insert(dir.to_path_buf(), now);
        }
    }

    /// True iff `dir` is currently flagged volatile.
    pub fn is_volatile(&self, dir: &Path) -> bool {
        self.volatile_since.contains_key(dir)
    }

    /// Release any volatile dir whose last_breach is older than `cooldown`.
    /// Returns the released paths so callers can emit subtreeResynced.
    pub fn flush(&mut self, now: Instant) -> Vec<PathBuf> {
        let mut released = Vec::new();
        let cooldown = self.cooldown;
        let candidates: Vec<PathBuf> = self.volatile_since.keys().cloned().collect();
        for dir in candidates {
            let last = self
                .last_breach
                .get(&dir)
                .copied()
                .unwrap_or_else(|| self.volatile_since[&dir]);
            if now.duration_since(last) >= cooldown {
                self.volatile_since.remove(&dir);
                self.last_breach.remove(&dir);
                self.activity.remove(&dir);
                released.push(dir);
            }
        }
        released
    }

    /// Snapshot of currently-volatile paths. Test/introspection helper.
    pub fn volatile_paths(&self) -> Vec<PathBuf> {
        self.volatile_since.keys().cloned().collect()
    }
}

impl Default for VolatileTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker() -> VolatileTracker {
        // Small threshold speeds up tests without changing semantics.
        VolatileTracker::with_config(
            200,
            Duration::from_secs(1),
            Duration::from_secs(2),
        )
    }

    #[test]
    fn tracker_does_not_flip_below_threshold() {
        let mut t = tracker();
        let base = Instant::now();
        let dir = PathBuf::from("/a");
        // 150 events within 1s — under threshold 200.
        for i in 0..150 {
            t.record(&dir, base + Duration::from_millis(i * 5));
        }
        assert!(!t.is_volatile(&dir));
    }

    #[test]
    fn tracker_flips_at_threshold() {
        let mut t = tracker();
        let base = Instant::now();
        let dir = PathBuf::from("/a");
        // 201 events within ~200ms — comfortably over threshold.
        for i in 0..201 {
            t.record(&dir, base + Duration::from_millis(i));
        }
        assert!(t.is_volatile(&dir));
    }

    #[test]
    fn tracker_releases_after_cooldown() {
        let mut t = tracker();
        let base = Instant::now();
        let dir = PathBuf::from("/a");
        for i in 0..250 {
            t.record(&dir, base + Duration::from_millis(i));
        }
        assert!(t.is_volatile(&dir));

        // Advance past the 2s cooldown without further activity.
        let released = t.flush(base + Duration::from_millis(250) + Duration::from_secs(3));
        assert!(released.iter().any(|p| p == &dir));
        assert!(!t.is_volatile(&dir));
    }

    #[test]
    fn tracker_handles_multiple_dirs_independently() {
        let mut t = tracker();
        let base = Instant::now();
        let busy = PathBuf::from("/busy");
        let quiet = PathBuf::from("/quiet");
        for i in 0..210 {
            t.record(&busy, base + Duration::from_millis(i));
        }
        t.record(&quiet, base);
        assert!(t.is_volatile(&busy));
        assert!(!t.is_volatile(&quiet));
    }

    #[test]
    fn tracker_trims_old_samples() {
        let mut t = tracker();
        let base = Instant::now();
        let dir = PathBuf::from("/a");
        // 150 events at t=0..150ms.
        for i in 0..150 {
            t.record(&dir, base + Duration::from_millis(i));
        }
        // 3 seconds later, a single event — old samples must be purged.
        t.record(&dir, base + Duration::from_secs(3));
        assert!(!t.is_volatile(&dir));
        // Internal state: only the fresh sample remains in window.
        let samples = t.activity.get(&dir).unwrap();
        assert_eq!(samples.len(), 1);
    }

    #[test]
    fn tracker_stays_volatile_while_active() {
        let mut t = tracker();
        let base = Instant::now();
        let dir = PathBuf::from("/a");
        for i in 0..210 {
            t.record(&dir, base + Duration::from_millis(i));
        }
        assert!(t.is_volatile(&dir));

        // Keep poking it past the cooldown; flush should NOT release it.
        let mut now = base + Duration::from_millis(210);
        for _ in 0..10 {
            now += Duration::from_millis(500);
            t.record(&dir, now);
            let released = t.flush(now);
            assert!(released.is_empty(), "should not release while active");
        }
        assert!(t.is_volatile(&dir));
    }

    #[test]
    fn volatile_paths_reflects_state() {
        let mut t = tracker();
        let base = Instant::now();
        let dir = PathBuf::from("/a");
        for i in 0..210 {
            t.record(&dir, base + Duration::from_millis(i));
        }
        let paths = t.volatile_paths();
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0], dir);
    }
}
