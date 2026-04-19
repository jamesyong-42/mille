//! Linux inotify limit auto-detect + hybrid-fallback advisor
//! (SPEC §4.4 "Linux inotify limit", PLAN 3.8).
//!
//! Reads `/proc/sys/fs/inotify/max_user_watches` on Linux; returns
//! `u32::MAX` (unlimited) on any other platform or on read/parse error.
//!
//! `advise_budget(projected_dirs)` is pure: given a projected watch
//! count it returns `Ok` / `NearLimit` / `Exceeds`. Phase 5 uses this
//! to decide whether to fall back to PollWatcher for overflow subtrees.

#[derive(Clone, Copy, Debug)]
pub struct InotifyLimits {
    /// `/proc/sys/fs/inotify/max_user_watches`. `u32::MAX` means unknown
    /// or non-Linux (treat as unlimited).
    pub max_user_watches: u32,
    /// Approximate in-use count. We don't try to read /proc/self/fdinfo
    /// — callers do their own accounting. 0 means unknown.
    pub in_use_estimate: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchBudget {
    /// Projected < 80% of limit. Proceed normally.
    Ok,
    /// Projected >= 80% of limit. Warn; consider PollWatcher fallback.
    NearLimit { headroom: u32 },
    /// Projected > limit. Must use polling or reject.
    Exceeds { over_by: u32 },
}

/// Read current inotify limits. Linux-only real read; other platforms
/// return unlimited.
pub fn current_limits() -> InotifyLimits {
    #[cfg(target_os = "linux")]
    {
        let max_user_watches = std::fs::read_to_string("/proc/sys/fs/inotify/max_user_watches")
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(u32::MAX);
        InotifyLimits {
            max_user_watches,
            in_use_estimate: 0,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        InotifyLimits {
            max_user_watches: u32::MAX,
            in_use_estimate: 0,
        }
    }
}

/// Advise based on the currently-observed limits.
pub fn advise_budget(projected_dirs: u32) -> WatchBudget {
    advise_budget_with(current_limits(), projected_dirs)
}

/// Pure-logic variant: advise given synthetic limits. Crate-local for
/// deterministic unit tests that don't touch /proc.
pub(crate) fn advise_budget_with(limits: InotifyLimits, projected: u32) -> WatchBudget {
    // Unknown / unlimited shortcut.
    if limits.max_user_watches == u32::MAX {
        return WatchBudget::Ok;
    }
    let max = limits.max_user_watches;
    if projected > max {
        return WatchBudget::Exceeds {
            over_by: projected - max,
        };
    }
    // 80% threshold — compute as u64 to avoid overflow at u32::MAX boundary.
    let threshold = ((max as u64) * 80 / 100) as u32;
    if projected >= threshold {
        WatchBudget::NearLimit {
            headroom: max - projected,
        }
    } else {
        WatchBudget::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(max: u32) -> InotifyLimits {
        InotifyLimits {
            max_user_watches: max,
            in_use_estimate: 0,
        }
    }

    #[test]
    fn advise_budget_ok_when_well_below_limit() {
        assert_eq!(advise_budget_with(limits(10_000), 100), WatchBudget::Ok);
    }

    #[test]
    fn advise_budget_warns_near_limit() {
        match advise_budget_with(limits(10_000), 8_500) {
            WatchBudget::NearLimit { headroom } => assert_eq!(headroom, 1_500),
            other => panic!("expected NearLimit, got {:?}", other),
        }
    }

    #[test]
    fn advise_budget_exceeds_when_over() {
        assert_eq!(
            advise_budget_with(limits(10_000), 15_000),
            WatchBudget::Exceeds { over_by: 5_000 }
        );
    }

    #[test]
    fn advise_budget_ok_when_unknown_limit() {
        assert_eq!(advise_budget_with(limits(u32::MAX), 100), WatchBudget::Ok);
        assert_eq!(
            advise_budget_with(limits(u32::MAX), 1_000_000),
            WatchBudget::Ok
        );
    }

    #[test]
    fn advise_budget_at_exact_threshold_warns() {
        // 80% of 10_000 = 8_000 exactly.
        match advise_budget_with(limits(10_000), 8_000) {
            WatchBudget::NearLimit { headroom } => assert_eq!(headroom, 2_000),
            other => panic!("expected NearLimit at exact threshold, got {:?}", other),
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn current_limits_returns_something_on_linux() {
        let l = current_limits();
        // Either a real readable limit, or u32::MAX if /proc wasn't readable
        // (unusual but possible in sandboxed CI). Either is acceptable here.
        assert!(l.max_user_watches > 0);
    }

    #[test]
    #[cfg(not(target_os = "linux"))]
    fn current_limits_is_unlimited_on_non_linux() {
        let l = current_limits();
        assert_eq!(l.max_user_watches, u32::MAX);
        assert_eq!(l.in_use_estimate, 0);
    }
}
