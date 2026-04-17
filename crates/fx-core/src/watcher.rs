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
    /// Phase 3.2: `Some(ms)` enables the `notify-debouncer-full` backend
    /// with that window; `None` passes raw platform events straight
    /// through (the 3.1 path). Default is `Some(75)` per SPEC §4.4 —
    /// balances event-storm suppression against editor-typing latency.
    pub debounce_ms: Option<u64>,
}

impl Default for WatcherOptions {
    fn default() -> Self {
        Self {
            recursive: true,
            debounce_ms: Some(75),
        }
    }
}

/// Backend the Watcher is driving. Both variants share the same
/// watched-roots bookkeeping and shutdown path.
enum NotifyBackend {
    Raw(RecommendedWatcher),
    Debounced(
        notify_debouncer_full::Debouncer<
            RecommendedWatcher,
            notify_debouncer_full::FileIdMap,
        >,
    ),
}

impl NotifyBackend {
    fn watch(&mut self, path: &Path, mode: RecursiveMode) -> notify::Result<()> {
        match self {
            NotifyBackend::Raw(w) => w.watch(path, mode),
            NotifyBackend::Debounced(d) => {
                d.watcher().watch(path, mode)?;
                // The FileIdMap cache stitches From/To rename events on
                // backends (FSEvents, Windows) that don't provide cookies.
                d.cache().add_root(path, mode);
                Ok(())
            }
        }
    }

    fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
        match self {
            NotifyBackend::Raw(w) => w.unwatch(path),
            NotifyBackend::Debounced(d) => {
                d.watcher().unwatch(path)?;
                d.cache().remove_root(path);
                Ok(())
            }
        }
    }
}

pub struct Watcher {
    // `Option` so `Drop` can take the backend out and release it cleanly
    // before we tell the forwarding thread to stop.
    inner: Mutex<Option<NotifyBackend>>,
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
    ///
    /// Uses `WatcherOptions::default()`, which enables the debouncer at
    /// the spec'd 75ms window (SPEC §4.4). For an unmediated raw stream
    /// use `new_with_options` and pass `debounce_ms: None`.
    pub fn new<F>(callback: F) -> Result<Self, FxError>
    where
        F: Fn(RawEvent) + Send + Sync + 'static,
    {
        Self::new_with_options(callback, WatcherOptions::default())
    }

    /// Construct a Watcher with explicit options. Selects the backend
    /// (raw vs. debounced) from `options.debounce_ms` at construction;
    /// cannot be changed afterwards — drop and rebuild if you need to.
    pub fn new_with_options<F>(callback: F, options: WatcherOptions) -> Result<Self, FxError>
    where
        F: Fn(RawEvent) + Send + Sync + 'static,
    {
        let callback = Arc::new(callback);
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();

        let (backend, handle) = match options.debounce_ms {
            None => build_raw_backend(Arc::clone(&callback), shutdown_rx)?,
            Some(ms) => build_debounced_backend(Arc::clone(&callback), ms, shutdown_rx)?,
        };

        Ok(Self {
            inner: Mutex::new(Some(backend)),
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
// Backend constructors

fn build_raw_backend<F>(
    callback: Arc<F>,
    shutdown_rx: mpsc::Receiver<()>,
) -> Result<(NotifyBackend, JoinHandle<()>), FxError>
where
    F: Fn(RawEvent) + Send + Sync + 'static,
{
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    // 2s poll fallback is notify's default for platforms without native
    // events; harmless on macOS/Linux/Windows where native is used.
    let config = Config::default().with_poll_interval(Duration::from_secs(2));
    let watcher = RecommendedWatcher::new(
        move |res: notify::Result<Event>| {
            let _ = tx.send(res);
        },
        config,
    )
    .map_err(map_notify_err)?;

    let handle = std::thread::Builder::new()
        .name("fx-core watcher forwarder".into())
        .spawn(move || forward_raw_loop(rx, shutdown_rx, callback))
        .map_err(|e| FxError::InternalBug(format!("failed to spawn watcher thread: {e}")))?;

    Ok((NotifyBackend::Raw(watcher), handle))
}

fn build_debounced_backend<F>(
    callback: Arc<F>,
    debounce_ms: u64,
    shutdown_rx: mpsc::Receiver<()>,
) -> Result<(NotifyBackend, JoinHandle<()>), FxError>
where
    F: Fn(RawEvent) + Send + Sync + 'static,
{
    use notify_debouncer_full::{new_debouncer, DebounceEventResult};

    let (tx, rx) = mpsc::channel::<DebounceEventResult>();
    // tick_rate = None lets the debouncer pick ~timeout/4, which
    // matches the recommended upstream default.
    let debouncer = new_debouncer(
        Duration::from_millis(debounce_ms),
        None,
        move |res: DebounceEventResult| {
            let _ = tx.send(res);
        },
    )
    .map_err(map_notify_err)?;

    let handle = std::thread::Builder::new()
        .name("fx-core watcher forwarder (debounced)".into())
        .spawn(move || forward_debounced_loop(rx, shutdown_rx, callback))
        .map_err(|e| FxError::InternalBug(format!("failed to spawn watcher thread: {e}")))?;

    Ok((NotifyBackend::Debounced(debouncer), handle))
}

// ---------------------------------------------------------------------------
// Forwarding loops

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

fn forward_debounced_loop<F>(
    rx: mpsc::Receiver<notify_debouncer_full::DebounceEventResult>,
    shutdown_rx: mpsc::Receiver<()>,
    callback: Arc<F>,
) where
    F: Fn(RawEvent) + Send + Sync + 'static,
{
    loop {
        if shutdown_rx.try_recv().is_ok() {
            return;
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(events)) => {
                for ev in events {
                    dispatch_event(&ev.event, &*callback);
                }
            }
            Ok(Err(errors)) => {
                for err in errors {
                    callback(RawEvent::Error(err.to_string()));
                }
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
// Coalescer (Phase 3.6) — pure RawEvent batch -> FsChangeEvent batch.
//
// Sits between the platform stream and the api-visible event union. Operates
// over a single debounce window's worth of raw events; no async / threading.
// Phase 5 wires this between the Debouncer's output and the NAPI binding.

/// High-level event surfaced by the coalescer. Mirrors the api.d.ts
/// `FileSystemEvent` union (minus `Renamed`, deferred to 3.3-3.5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FsChangeEvent {
    /// A new file/dir. Phase 3.6 emits this for any Create that isn't
    /// cancelled by a subsequent Delete within the same batch.
    Created { path: PathBuf },
    /// Content change. Modified×N collapsed to one.
    Modified { path: PathBuf },
    /// File/dir removed.
    Deleted { path: PathBuf },
    /// Platform emitted an ambiguous event (rename half, access flag, etc.).
    /// Phase 3.3-3.5 will convert paired Unknown events into Renamed.
    Unknown { path: PathBuf },
    /// Watcher backlog overflow on this root; caller should re-walk it.
    Coarse { root: PathBuf },
    /// Transient platform-level error (not fatal).
    Error { message: String },
}

/// Per-path coalesced state. Tracks the net effect of a sequence of raw
/// events on a single path inside one debounce window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PathState {
    /// Net effect: a Create. Either a fresh Create, or Delete+Create
    /// (atomic replace), or Create followed by any number of Modifies
    /// (the Modifies are implied by the Create).
    Created,
    /// Net effect: a Modify. One or more Modifies on a pre-existing path.
    Modified,
    /// Net effect: a Delete. Path is gone after this batch.
    Deleted,
    /// Ambiguous (e.g. rename half). Pending pairing in 3.3-3.5.
    Unknown,
    /// Create+Delete inside the window — transient file. Drop entirely.
    Cancelled,
}

/// Run one coalesce pass over a raw event batch from a debounce window.
/// Pure. Deterministic. Same input → same output.
///
/// Algorithm: group by path, run a small state machine per group, then
/// emit one event per path in first-seen order. `Overflow` and `Error`
/// are not grouped per path and pass through inline.
pub fn coalesce_events(raw: &[RawEvent]) -> Vec<FsChangeEvent> {
    use std::collections::HashMap;

    // Per-path running state, plus the index of first appearance so we
    // can emit in deterministic first-seen order.
    let mut state: HashMap<PathBuf, PathState> = HashMap::new();
    let mut first_seen: Vec<PathBuf> = Vec::new();

    // Output buffer. Overflow/Error events are appended inline at the
    // position they appeared, preserving relative order with first-seen
    // path events.
    let mut out: Vec<FsChangeEvent> = Vec::new();
    // Marker indices in `out` for each first-seen path so we can patch
    // the final coalesced event in place once the batch is fully scanned.
    let mut path_slot: HashMap<PathBuf, usize> = HashMap::new();

    for ev in raw {
        match ev {
            RawEvent::Overflow { root } => {
                out.push(FsChangeEvent::Coarse { root: root.clone() });
            }
            RawEvent::Error(msg) => {
                out.push(FsChangeEvent::Error { message: msg.clone() });
            }
            RawEvent::Created(p)
            | RawEvent::Modified(p)
            | RawEvent::Deleted(p)
            | RawEvent::Any(p) => {
                // Reserve a slot for this path on first appearance so its
                // position in the output matches first-seen order.
                if !path_slot.contains_key(p) {
                    path_slot.insert(p.clone(), out.len());
                    first_seen.push(p.clone());
                    // Placeholder; overwritten below before return.
                    out.push(FsChangeEvent::Unknown { path: p.clone() });
                }
                let next = transition(state.get(p).copied(), ev);
                state.insert(p.clone(), next);
            }
        }
    }

    // Patch each path slot with its final coalesced event, dropping
    // cancelled paths by collecting into a fresh vector that skips them.
    let mut final_out: Vec<FsChangeEvent> = Vec::with_capacity(out.len());
    let mut emitted_path: HashMap<usize, ()> = HashMap::new();
    for (idx, slot) in out.into_iter().enumerate() {
        // Find the path that owns this slot, if any.
        let owner = first_seen.iter().find(|p| path_slot[*p] == idx);
        match owner {
            Some(p) => {
                if emitted_path.contains_key(&idx) {
                    continue;
                }
                emitted_path.insert(idx, ());
                match state[p] {
                    PathState::Cancelled => { /* drop transient file */ }
                    PathState::Created => {
                        final_out.push(FsChangeEvent::Created { path: p.clone() });
                    }
                    PathState::Modified => {
                        final_out.push(FsChangeEvent::Modified { path: p.clone() });
                    }
                    PathState::Deleted => {
                        final_out.push(FsChangeEvent::Deleted { path: p.clone() });
                    }
                    PathState::Unknown => {
                        final_out.push(FsChangeEvent::Unknown { path: p.clone() });
                    }
                }
            }
            None => {
                // Pass-through Coarse / Error.
                final_out.push(slot);
            }
        }
    }

    final_out
}

/// State-machine transition. `prev` is the current state for this path
/// (or None on first event). `ev` is the incoming raw event — it must
/// be a path-bearing variant (Created/Modified/Deleted/Any); Overflow
/// and Error are handled inline by the caller and never reach here.
fn transition(prev: Option<PathState>, ev: &RawEvent) -> PathState {
    match (prev, ev) {
        // First event for this path.
        (None, RawEvent::Created(_)) => PathState::Created,
        (None, RawEvent::Modified(_)) => PathState::Modified,
        (None, RawEvent::Deleted(_)) => PathState::Deleted,
        (None, RawEvent::Any(_)) => PathState::Unknown,

        // Created → ...
        // Create+Modify keeps the Create (Modifies implied by the Create).
        (Some(PathState::Created), RawEvent::Modified(_)) => PathState::Created,
        // Create+Delete cancels — transient file inside the window.
        (Some(PathState::Created), RawEvent::Deleted(_)) => PathState::Cancelled,
        // Duplicate Create — stay Created.
        (Some(PathState::Created), RawEvent::Created(_)) => PathState::Created,
        // Create+Any — treat ambiguous follow-up as no-op on the Create.
        (Some(PathState::Created), RawEvent::Any(_)) => PathState::Created,

        // Modified → ...
        (Some(PathState::Modified), RawEvent::Modified(_)) => PathState::Modified,
        // Modify+Delete — file is gone, Modifies are irrelevant.
        (Some(PathState::Modified), RawEvent::Deleted(_)) => PathState::Deleted,
        // Modify+Create — odd but plausible (deleted-then-recreated event
        // arriving out of order). Promote to Created.
        (Some(PathState::Modified), RawEvent::Created(_)) => PathState::Created,
        (Some(PathState::Modified), RawEvent::Any(_)) => PathState::Modified,

        // Deleted → ...
        // Delete+Create — atomic replace / path reuse. Net effect Create.
        (Some(PathState::Deleted), RawEvent::Created(_)) => PathState::Created,
        // Delete+Modify — shouldn't happen (file gone), but be defensive.
        (Some(PathState::Deleted), RawEvent::Modified(_)) => PathState::Deleted,
        (Some(PathState::Deleted), RawEvent::Deleted(_)) => PathState::Deleted,
        (Some(PathState::Deleted), RawEvent::Any(_)) => PathState::Deleted,

        // Unknown → ... (preserve Unknown unless concretely overwritten).
        (Some(PathState::Unknown), RawEvent::Created(_)) => PathState::Created,
        (Some(PathState::Unknown), RawEvent::Modified(_)) => PathState::Modified,
        (Some(PathState::Unknown), RawEvent::Deleted(_)) => PathState::Deleted,
        (Some(PathState::Unknown), RawEvent::Any(_)) => PathState::Unknown,

        // Cancelled is sticky within the batch — once we've seen
        // Create+Delete, additional events on this path get a fresh start
        // by re-promoting to whatever the new event suggests. This is the
        // C+D+C case: third Create reanimates as Created.
        (Some(PathState::Cancelled), RawEvent::Created(_)) => PathState::Created,
        (Some(PathState::Cancelled), RawEvent::Modified(_)) => PathState::Modified,
        (Some(PathState::Cancelled), RawEvent::Deleted(_)) => PathState::Deleted,
        (Some(PathState::Cancelled), RawEvent::Any(_)) => PathState::Unknown,

        // Non-path-bearing variants never reach here.
        (_, RawEvent::Overflow { .. }) | (_, RawEvent::Error(_)) => {
            prev.unwrap_or(PathState::Unknown)
        }
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

    fn make_watcher_with(events: Events, options: WatcherOptions) -> Watcher {
        Watcher::new_with_options(
            move |ev| {
                events.lock().unwrap().push(ev);
            },
            options,
        )
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
        // Raw mode so we see the Modify explicitly — the debouncer
        // (tested separately) may fold Modify-after-Create.
        let opts = WatcherOptions {
            recursive: true,
            debounce_ms: None,
        };
        let w = make_watcher_with(Arc::clone(&events), opts.clone());
        w.watch(td.path(), opts).unwrap();

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
        // Raw mode — debouncer may re-classify a delete after a recent
        // create/modify via its FileIdMap stitching; 3.1 semantics tested
        // here use the raw stream.
        let opts = WatcherOptions {
            recursive: true,
            debounce_ms: None,
        };
        let w = make_watcher_with(Arc::clone(&events), opts.clone());
        w.watch(td.path(), opts).unwrap();

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

    // ---- Phase 3.2: debouncer backend ----

    #[test]
    fn raw_watcher_without_debouncer_still_works() {
        let td = TempDir::new().unwrap();
        let events: Events = Arc::new(StdMutex::new(Vec::new()));
        let opts = WatcherOptions {
            recursive: true,
            debounce_ms: None,
        };
        let w = make_watcher_with(Arc::clone(&events), opts.clone());
        w.watch(td.path(), opts).unwrap();

        std::thread::sleep(Duration::from_millis(50));
        let f = td.path().join("raw.txt");
        fs::write(&f, b"a").unwrap();
        fs::write(&f, b"bb").unwrap();

        let got = poll_for(&events, Duration::from_secs(2), |evs| {
            evs.iter().any(|e| path_matches(e, "raw.txt"))
        });
        assert!(
            got.iter().any(|e| path_matches(e, "raw.txt")),
            "raw backend should still deliver events: {got:?}"
        );
    }

    #[test]
    fn debounced_watcher_merges_rapid_modifies() {
        let td = TempDir::new().unwrap();
        let target = td.path().join("hot.txt");
        fs::write(&target, b"0").unwrap();

        let events: Events = Arc::new(StdMutex::new(Vec::new()));
        let opts = WatcherOptions {
            recursive: true,
            debounce_ms: Some(200),
        };
        let w = make_watcher_with(Arc::clone(&events), opts.clone());
        w.watch(td.path(), opts).unwrap();

        std::thread::sleep(Duration::from_millis(100));

        // 10 rapid modifies well within the 200ms debounce window.
        for i in 0..10u8 {
            fs::write(&target, [b'a' + i]).unwrap();
        }

        // Wait past the debounce window + tick (~50ms) for emission.
        std::thread::sleep(Duration::from_millis(700));

        let got = events.lock().unwrap().clone();
        let modify_count = got
            .iter()
            .filter(|e| matches!(e, RawEvent::Modified(_)) && path_matches(e, "hot.txt"))
            .count();
        assert!(
            modify_count <= 5,
            "debouncer should merge rapid modifies, got {modify_count}: {got:?}"
        );
    }

    // ---- Phase 3.6: coalescer ----

    fn pb(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn coalesce_single_create_passes_through() {
        let raw = vec![RawEvent::Created(pb("/a"))];
        let out = coalesce_events(&raw);
        assert_eq!(out, vec![FsChangeEvent::Created { path: pb("/a") }]);
    }

    #[test]
    fn coalesce_create_then_delete_cancels() {
        let raw = vec![RawEvent::Created(pb("/a")), RawEvent::Deleted(pb("/a"))];
        let out = coalesce_events(&raw);
        assert!(out.is_empty(), "C+D should cancel: {out:?}");
    }

    #[test]
    fn coalesce_create_delete_create_yields_single_create() {
        let raw = vec![
            RawEvent::Created(pb("/a")),
            RawEvent::Deleted(pb("/a")),
            RawEvent::Created(pb("/a")),
        ];
        let out = coalesce_events(&raw);
        assert_eq!(out, vec![FsChangeEvent::Created { path: pb("/a") }]);
    }

    #[test]
    fn coalesce_collapses_repeated_modifies() {
        let raw = vec![
            RawEvent::Modified(pb("/a")),
            RawEvent::Modified(pb("/a")),
            RawEvent::Modified(pb("/a")),
            RawEvent::Modified(pb("/a")),
        ];
        let out = coalesce_events(&raw);
        assert_eq!(out, vec![FsChangeEvent::Modified { path: pb("/a") }]);
    }

    #[test]
    fn coalesce_modify_then_delete_becomes_delete() {
        let raw = vec![
            RawEvent::Modified(pb("/a")),
            RawEvent::Modified(pb("/a")),
            RawEvent::Deleted(pb("/a")),
        ];
        let out = coalesce_events(&raw);
        assert_eq!(out, vec![FsChangeEvent::Deleted { path: pb("/a") }]);
    }

    #[test]
    fn coalesce_delete_then_create_becomes_create() {
        let raw = vec![RawEvent::Deleted(pb("/a")), RawEvent::Created(pb("/a"))];
        let out = coalesce_events(&raw);
        assert_eq!(out, vec![FsChangeEvent::Created { path: pb("/a") }]);
    }

    #[test]
    fn coalesce_preserves_per_path_ordering() {
        // Two paths, distinct events. Output must contain one event per
        // path, in first-seen order (a before b), with no interleaving.
        let raw = vec![
            RawEvent::Created(pb("/a")),
            RawEvent::Modified(pb("/b")),
            RawEvent::Modified(pb("/a")),
            RawEvent::Modified(pb("/b")),
        ];
        let out = coalesce_events(&raw);
        assert_eq!(
            out,
            vec![
                FsChangeEvent::Created { path: pb("/a") },
                FsChangeEvent::Modified { path: pb("/b") },
            ]
        );
    }

    #[test]
    fn coalesce_unknown_passes_through() {
        let raw = vec![RawEvent::Any(pb("/a"))];
        let out = coalesce_events(&raw);
        assert_eq!(out, vec![FsChangeEvent::Unknown { path: pb("/a") }]);
    }

    #[test]
    fn coalesce_overflow_passes_through() {
        let raw = vec![RawEvent::Overflow { root: pb("/root") }];
        let out = coalesce_events(&raw);
        assert_eq!(out, vec![FsChangeEvent::Coarse { root: pb("/root") }]);
    }

    #[test]
    fn coalesce_error_passes_through() {
        let raw = vec![RawEvent::Error("boom".into())];
        let out = coalesce_events(&raw);
        assert_eq!(
            out,
            vec![FsChangeEvent::Error {
                message: "boom".into()
            }]
        );
    }

    #[test]
    fn coalesce_empty_batch_returns_empty() {
        let out = coalesce_events(&[]);
        assert!(out.is_empty());
    }

    #[test]
    fn coalesce_mixed_batch_big() {
        // 5 paths, 20 raw events covering each documented case:
        //   /a — Created+Modified×3            → Created
        //   /b — Modified×4                    → Modified
        //   /c — Created+Deleted               → cancelled (no event)
        //   /d — Modified+Deleted              → Deleted
        //   /e — Deleted+Created               → Created
        let raw = vec![
            RawEvent::Created(pb("/a")),
            RawEvent::Modified(pb("/b")),
            RawEvent::Created(pb("/c")),
            RawEvent::Modified(pb("/d")),
            RawEvent::Deleted(pb("/e")),
            RawEvent::Modified(pb("/a")),
            RawEvent::Modified(pb("/b")),
            RawEvent::Deleted(pb("/c")),
            RawEvent::Modified(pb("/d")),
            RawEvent::Created(pb("/e")),
            RawEvent::Modified(pb("/a")),
            RawEvent::Modified(pb("/b")),
            RawEvent::Modified(pb("/d")),
            RawEvent::Modified(pb("/a")),
            RawEvent::Modified(pb("/b")),
            RawEvent::Deleted(pb("/d")),
            RawEvent::Modified(pb("/a")),
            RawEvent::Modified(pb("/b")),
            RawEvent::Modified(pb("/a")),
            RawEvent::Modified(pb("/b")),
        ];
        let out = coalesce_events(&raw);
        assert!(
            out.len() < raw.len(),
            "coalesced output should be strictly smaller: {out:?}"
        );
        // /c cancelled, so 4 paths produce events.
        assert_eq!(out.len(), 4, "one event per surviving path: {out:?}");
        assert_eq!(
            out,
            vec![
                FsChangeEvent::Created { path: pb("/a") },
                FsChangeEvent::Modified { path: pb("/b") },
                FsChangeEvent::Deleted { path: pb("/d") },
                FsChangeEvent::Created { path: pb("/e") },
            ]
        );
    }

    #[test]
    fn debounced_watcher_respects_debounce_window() {
        let td = TempDir::new().unwrap();
        let target = td.path().join("slow.txt");
        fs::write(&target, b"0").unwrap();

        let events: Events = Arc::new(StdMutex::new(Vec::new()));
        let opts = WatcherOptions {
            recursive: true,
            debounce_ms: Some(500),
        };
        let w = make_watcher_with(Arc::clone(&events), opts.clone());
        w.watch(td.path(), opts).unwrap();

        std::thread::sleep(Duration::from_millis(100));
        fs::write(&target, b"changed").unwrap();

        // Flaky-sensitive: don't assert timing precisely, just that we
        // receive at least one event within 1.5s (strictly bounded by
        // debounce_ms + tick_rate + platform latency).
        let got = poll_for(&events, Duration::from_millis(1500), |evs| {
            evs.iter().any(|e| path_matches(e, "slow.txt"))
        });
        assert!(
            got.iter().any(|e| path_matches(e, "slow.txt")),
            "debouncer should emit event for slow.txt within 1.5s: {got:?}"
        );
    }
}
