//! File-system watcher (SPEC §4.4, PLAN Phase 3).
//!
//! Phase 3.1 (this file, current commit): thin wrapper over
//! `notify::RecommendedWatcher`. Forwards raw platform events on a
//! background thread via a user-supplied callback. `watch()`/`unwatch()`
//! maintain a watched-roots set and absorb nested paths.
//!
//! Out of scope here (tracked by later commits):
//!   - Phase 3.2 — `notify-debouncer-full` integration (debounce_ms).
//!   - Phase 3.3-3.5 — rename pairing (Any → Renamed).
//!   - Phase 3.6 — non-recursive mode + high-level `FileSystemEvent`
//!     coalescer (create+delete merge, modified-N → 1, etc.).
//!   - Phase 3.7+ — volatile-path throttling, overflow recovery walk.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use notify::{
    event::{ModifyKind, RenameMode},
    Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher,
};

use crate::error::{ErrorCode, FxError};

/// Raw platform event before debouncing / rename pairing / coalescing.
/// Phase 3.2 wraps this in a Debounced variant; Phase 3.6 converts these
/// into high-level FileSystemEvent records. Do NOT design for those now.
#[derive(Clone, Debug)]
pub enum RawEvent {
    Created(PathBuf),
    Modified(PathBuf),
    Deleted(PathBuf),
    /// Platform-specific "something happened here, we're not sure what".
    /// macOS FSEvents and Windows ReadDirectoryChangesW both emit these.
    /// Phase 3.3-3.5 rename pairing converts some of these into Renamed.
    Any(PathBuf),
    /// Watcher backlog overflowed. Subtree flagged coarse; caller re-walks.
    Overflow { root: PathBuf },
    /// Transient platform-level error. Not fatal; logged.
    Error(String),
}

#[derive(Clone, Debug)]
pub struct WatcherOptions {
    /// True to watch subtrees recursively (default). Non-recursive will
    /// land in Phase 3.6 — for 3.1 we only support recursive.
    pub recursive: bool,
}

impl Default for WatcherOptions {
    fn default() -> Self {
        Self { recursive: true }
    }
}

pub struct Watcher {
    // `Option` so `Drop` can take the watcher out and release it cleanly
    // before we tell the forwarding thread to stop.
    inner: Mutex<Option<RecommendedWatcher>>,
    roots: Mutex<Vec<PathBuf>>,
    // Signals the forwarding thread to exit. Sender stored so `Drop` can
    // fire it; receiver lives on the forwarding thread.
    shutdown: Mutex<Option<mpsc::Sender<()>>>,
    forwarder: Mutex<Option<JoinHandle<()>>>,
}

impl Watcher {
    /// Spawn a watcher. `callback` is called from a background thread on
    /// each raw event. It must be `Send + Sync` since notify invokes it
    /// from its own worker thread.
    pub fn new<F>(callback: F) -> Result<Self, FxError>
    where
        F: Fn(RawEvent) + Send + Sync + 'static,
    {
        let callback = Arc::new(callback);
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

        // 2s poll fallback is notify's default for platforms without
        // native events; harmless on macOS/Linux/Windows (native used).
        let config = Config::default().with_poll_interval(Duration::from_secs(2));
        let watcher = RecommendedWatcher::new(
            move |res: notify::Result<Event>| {
                let _ = tx.send(res);
            },
            config,
        )
        .map_err(map_notify_err)?;

        let cb = Arc::clone(&callback);
        let handle = std::thread::Builder::new()
            .name("fx-core watcher forwarder".into())
            .spawn(move || forward_raw_loop(rx, shutdown_rx, cb))
            .map_err(|e| FxError::InternalBug(format!("failed to spawn watcher thread: {e}")))?;

        Ok(Self {
            inner: Mutex::new(Some(watcher)),
            roots: Mutex::new(Vec::new()),
            shutdown: Mutex::new(Some(shutdown_tx)),
            forwarder: Mutex::new(Some(handle)),
        })
    }

    /// Start watching `root`. Idempotent. If an existing watched root is
    /// an ancestor of `root`, we skip (the outer watch already covers
    /// it). If `root` is an ancestor of any existing watched root, we
    /// unwatch the inner ones first then add `root`.
    pub fn watch(&self, root: &Path, options: WatcherOptions) -> Result<(), FxError> {
        if !options.recursive {
            // Non-recursive lands in Phase 3.6.
            return Err(FxError::Unsupported(
                "non-recursive watching lands in Phase 3.6".into(),
            ));
        }

        let canonical = canonicalize_or_owned(root);

        let mut roots = self.roots.lock().expect("roots mutex poisoned");
        let mut inner = self.inner.lock().expect("inner mutex poisoned");
        let watcher = inner
            .as_mut()
            .ok_or_else(|| FxError::InternalBug("watcher backend already dropped".into()))?;

        // Already watched — no-op.
        if roots.iter().any(|r| r == &canonical) {
            return Ok(());
        }

        // Existing outer root covers this one — absorb silently.
        if roots.iter().any(|r| is_ancestor_of(r, &canonical)) {
            return Ok(());
        }

        // This new root is an ancestor of one or more existing inner
        // roots — drop the inner ones first.
        let inner_roots: Vec<PathBuf> = roots
            .iter()
            .filter(|r| is_ancestor_of(&canonical, r))
            .cloned()
            .collect();
        for ir in &inner_roots {
            // Best-effort unwatch; if it's already gone, swallow.
            let _ = watcher.unwatch(ir);
        }
        roots.retain(|r| !inner_roots.contains(r));

        watcher
            .watch(&canonical, RecursiveMode::Recursive)
            .map_err(map_notify_err)?;
        roots.push(canonical);
        Ok(())
    }

    /// Stop watching `root`. No-op if not watched.
    pub fn unwatch(&self, root: &Path) -> Result<(), FxError> {
        let canonical = canonicalize_or_owned(root);
        let mut roots = self.roots.lock().expect("roots mutex poisoned");
        let mut inner = self.inner.lock().expect("inner mutex poisoned");
        let watcher = inner
            .as_mut()
            .ok_or_else(|| FxError::InternalBug("watcher backend already dropped".into()))?;

        let idx = match roots.iter().position(|r| r == &canonical) {
            Some(i) => i,
            None => return Ok(()),
        };
        watcher.unwatch(&canonical).map_err(map_notify_err)?;
        roots.remove(idx);
        Ok(())
    }

    /// List of currently-watched roots, for introspection.
    pub fn watched_roots(&self) -> Vec<PathBuf> {
        self.roots.lock().expect("roots mutex poisoned").clone()
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        // Order matters: drop the notify watcher first so it stops
        // pushing events, then signal the forwarding thread to exit.
        if let Ok(mut guard) = self.inner.lock() {
            guard.take();
        }
        if let Ok(mut guard) = self.shutdown.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
        if let Ok(mut guard) = self.forwarder.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Forwarding loop

fn forward_raw_loop<F>(
    rx: mpsc::Receiver<notify::Result<Event>>,
    shutdown_rx: mpsc::Receiver<()>,
    callback: Arc<F>,
) where
    F: Fn(RawEvent) + Send + Sync + 'static,
{
    // Short timeout keeps shutdown latency bounded without tight looping.
    loop {
        if shutdown_rx.try_recv().is_ok() {
            return;
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(event)) => dispatch_event(&event, &*callback),
            Ok(Err(err)) => {
                // Platform-level transient error; not fatal.
                callback(RawEvent::Error(err.to_string()));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Map a single notify `Event` to zero or more `RawEvent`s and dispatch.
/// A notify event can carry multiple paths (e.g. a rename with `[from, to]`);
/// we emit one RawEvent per path.
fn dispatch_event<F>(event: &Event, callback: &F)
where
    F: Fn(RawEvent) + ?Sized,
{
    // `EventKind::Other` on notify 6.x signals a rescan/backlog-overflow
    // on FSEvents; treat as Overflow so Phase 3.7+ can re-walk.
    if matches!(event.kind, EventKind::Other) {
        for path in &event.paths {
            callback(RawEvent::Overflow { root: path.clone() });
        }
        return;
    }

    for path in &event.paths {
        match &event.kind {
            EventKind::Create(_) => callback(RawEvent::Created(path.clone())),
            EventKind::Remove(_) => callback(RawEvent::Deleted(path.clone())),
            EventKind::Modify(ModifyKind::Data(_)) => callback(RawEvent::Modified(path.clone())),
            EventKind::Modify(ModifyKind::Name(RenameMode::From))
            | EventKind::Modify(ModifyKind::Name(RenameMode::To))
            | EventKind::Modify(ModifyKind::Name(RenameMode::Both))
            | EventKind::Modify(ModifyKind::Name(RenameMode::Any))
            | EventKind::Modify(ModifyKind::Name(RenameMode::Other)) => {
                // Phase 3.3-3.5 will pair From+To into a Renamed event.
                callback(RawEvent::Any(path.clone()));
            }
            EventKind::Modify(ModifyKind::Other) => callback(RawEvent::Modified(path.clone())),
            EventKind::Modify(_) => callback(RawEvent::Any(path.clone())),
            EventKind::Access(_) => { /* uninteresting */ }
            EventKind::Any => callback(RawEvent::Any(path.clone())),
            EventKind::Other => { /* handled above */ }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers

/// `true` if `ancestor` is a proper ancestor of `descendant` (or equal).
/// Used to decide whether a new watch root is absorbed by an existing one.
fn is_ancestor_of(ancestor: &Path, descendant: &Path) -> bool {
    descendant.starts_with(ancestor)
}

/// Try `canonicalize`; fall back to the input path if it doesn't exist yet
/// (notify itself will produce an error in that case, propagated by watch()).
fn canonicalize_or_owned(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn map_notify_err(err: notify::Error) -> FxError {
    // notify's Error doesn't expose a stable errno taxonomy, so fold
    // everything into ENOENT / Io / InternalBug based on the inner kind.
    use notify::ErrorKind;
    match err.kind {
        ErrorKind::PathNotFound => FxError::Io {
            code: ErrorCode::ENOENT,
            path: err.paths.into_iter().next().unwrap_or_default(),
            source: std::io::Error::from(std::io::ErrorKind::NotFound),
        },
        ErrorKind::Io(ref e) => {
            let path = err.paths.clone().into_iter().next().unwrap_or_default();
            ErrorCode::from_io_error(e, path)
        }
        _ => FxError::InternalBug(format!("notify: {err}")),
    }
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::sync::Mutex as StdMutex;
    use std::time::Instant;

    use tempfile::TempDir;

    type Events = Arc<StdMutex<Vec<RawEvent>>>;

    fn make_watcher(events: Events) -> Watcher {
        Watcher::new(move |ev| {
            events.lock().unwrap().push(ev);
        })
        .expect("watcher construction")
    }

    /// Poll up to `timeout` for `pred(events)` to return true. Returns the
    /// final events snapshot.
    fn poll_for(
        events: &Events,
        timeout: Duration,
        pred: impl Fn(&[RawEvent]) -> bool,
    ) -> Vec<RawEvent> {
        let start = Instant::now();
        while start.elapsed() < timeout {
            {
                let guard = events.lock().unwrap();
                if pred(&guard) {
                    return guard.clone();
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        events.lock().unwrap().clone()
    }

    fn path_matches(ev: &RawEvent, needle: &str) -> bool {
        let p = match ev {
            RawEvent::Created(p)
            | RawEvent::Modified(p)
            | RawEvent::Deleted(p)
            | RawEvent::Any(p) => p,
            _ => return false,
        };
        p.to_string_lossy().contains(needle)
    }

    #[test]
    fn watch_detects_file_create() {
        let td = TempDir::new().unwrap();
        let events: Events = Arc::new(StdMutex::new(Vec::new()));
        let w = make_watcher(Arc::clone(&events));
        w.watch(td.path(), WatcherOptions::default()).unwrap();

        // Brief settle so the platform has registered the watch.
        std::thread::sleep(Duration::from_millis(50));
        fs::write(td.path().join("new.txt"), b"x").unwrap();

        let got = poll_for(&events, Duration::from_secs(2), |evs| {
            evs.iter().any(|e| path_matches(e, "new.txt"))
        });
        assert!(
            got.iter().any(|e| path_matches(e, "new.txt")),
            "no event mentioning new.txt in {got:?}"
        );
    }

    #[test]
    fn watch_detects_file_modify() {
        let td = TempDir::new().unwrap();
        let target = td.path().join("mod.txt");
        fs::write(&target, b"a").unwrap();

        let events: Events = Arc::new(StdMutex::new(Vec::new()));
        let w = make_watcher(Arc::clone(&events));
        w.watch(td.path(), WatcherOptions::default()).unwrap();

        std::thread::sleep(Duration::from_millis(50));
        fs::write(&target, b"bb").unwrap();

        let got = poll_for(&events, Duration::from_secs(2), |evs| {
            evs.iter()
                .any(|e| matches!(e, RawEvent::Modified(_)) && path_matches(e, "mod.txt"))
        });
        assert!(
            got.iter()
                .any(|e| matches!(e, RawEvent::Modified(_)) && path_matches(e, "mod.txt")),
            "no modify event for mod.txt: {got:?}"
        );
    }

    #[test]
    fn watch_detects_file_delete() {
        let td = TempDir::new().unwrap();
        let target = td.path().join("gone.txt");
        fs::write(&target, b"bye").unwrap();

        let events: Events = Arc::new(StdMutex::new(Vec::new()));
        let w = make_watcher(Arc::clone(&events));
        w.watch(td.path(), WatcherOptions::default()).unwrap();

        std::thread::sleep(Duration::from_millis(50));
        fs::remove_file(&target).unwrap();

        let got = poll_for(&events, Duration::from_secs(2), |evs| {
            evs.iter()
                .any(|e| matches!(e, RawEvent::Deleted(_)) && path_matches(e, "gone.txt"))
        });
        assert!(
            got.iter()
                .any(|e| matches!(e, RawEvent::Deleted(_)) && path_matches(e, "gone.txt")),
            "no delete event for gone.txt: {got:?}"
        );
    }

    #[test]
    fn watch_recursive_detects_nested_create() {
        let td = TempDir::new().unwrap();
        let sub = td.path().join("sub");
        fs::create_dir(&sub).unwrap();

        let events: Events = Arc::new(StdMutex::new(Vec::new()));
        let w = make_watcher(Arc::clone(&events));
        w.watch(td.path(), WatcherOptions::default()).unwrap();

        std::thread::sleep(Duration::from_millis(50));
        fs::write(sub.join("nested.txt"), b"x").unwrap();

        let got = poll_for(&events, Duration::from_secs(2), |evs| {
            evs.iter().any(|e| path_matches(e, "nested.txt"))
        });
        assert!(
            got.iter().any(|e| path_matches(e, "nested.txt")),
            "no event mentioning nested.txt: {got:?}"
        );
    }

    #[test]
    fn watch_is_idempotent_for_same_root() {
        let td = TempDir::new().unwrap();
        let events: Events = Arc::new(StdMutex::new(Vec::new()));
        let w = make_watcher(Arc::clone(&events));
        w.watch(td.path(), WatcherOptions::default()).unwrap();
        w.watch(td.path(), WatcherOptions::default()).unwrap();
        assert_eq!(w.watched_roots().len(), 1);
    }

    #[test]
    fn watch_absorbs_nested_roots() {
        let td = TempDir::new().unwrap();
        let sub = td.path().join("sub");
        fs::create_dir(&sub).unwrap();

        let events: Events = Arc::new(StdMutex::new(Vec::new()));
        let w = make_watcher(Arc::clone(&events));
        w.watch(td.path(), WatcherOptions::default()).unwrap();
        w.watch(&sub, WatcherOptions::default()).unwrap();

        let roots = w.watched_roots();
        assert_eq!(roots.len(), 1, "nested root should be absorbed: {roots:?}");
        let expected = std::fs::canonicalize(td.path()).unwrap();
        assert_eq!(roots[0], expected);
    }

    #[test]
    fn unwatch_stops_receiving_events() {
        let td = TempDir::new().unwrap();
        let events: Events = Arc::new(StdMutex::new(Vec::new()));
        let w = make_watcher(Arc::clone(&events));
        w.watch(td.path(), WatcherOptions::default()).unwrap();
        w.unwatch(td.path()).unwrap();
        assert!(w.watched_roots().is_empty());

        // Give the platform a beat to actually stop watching.
        std::thread::sleep(Duration::from_millis(100));
        events.lock().unwrap().clear();

        fs::write(td.path().join("ghost.txt"), b"x").unwrap();

        // flaky: FSEvents latency — a lingering event could sneak in
        // just after unwatch. 200ms matches the spec window.
        std::thread::sleep(Duration::from_millis(200));
        let post = events.lock().unwrap().clone();
        assert!(
            !post.iter().any(|e| path_matches(e, "ghost.txt")),
            "should not receive events after unwatch: {post:?}"
        );
    }

    #[test]
    fn watcher_drops_cleanly() {
        let td = TempDir::new().unwrap();
        let events: Events = Arc::new(StdMutex::new(Vec::new()));
        {
            let w = make_watcher(Arc::clone(&events));
            w.watch(td.path(), WatcherOptions::default()).unwrap();
            assert_eq!(w.watched_roots().len(), 1);
        } // Drop runs here — inner dropped, shutdown sent, thread joined.

        // We at least confirm no panic. Reconstruction also works —
        // proves we released platform-side resources cleanly.
        let w2 = make_watcher(events);
        assert_eq!(w2.watched_roots().len(), 0);
    }
}
