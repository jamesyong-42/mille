//! FileExplorer `#[napi]` class.
//!
//! Owns the entry store, live filesystem watcher, mutations, snapshots,
//! typed event fan-out, and deterministic shutdown for local mode.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use napi::bindgen_prelude::{Buffer, Result, Status, Unknown};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::Error;
use napi_derive::napi;

use mille_core::{
    Entry, EntryId, EntryKind, EntryStore, FxError, IntentCache, IntentKind, Watcher,
};

use crate::error::{fx_error_to_napi, io_to_fx};
use crate::events::{Channel, EventBus};
use crate::mutations::{
    kind_from_u8, resolve_entry_path, stat_to_entry, DeleteOptionsJs, TransferOptionsJs,
};
use crate::snapshot::MirrorSnapshot;
use crate::types::{
    ChangeNoticeJs, ChangeSetJs, EntryJs, ErrorPayloadJs, FileSystemEventJs, SearchHitJs,
    SearchOptionsJs, WarningPayloadJs,
};

#[napi(object)]
pub struct FileNestingRuleJs {
    pub parent_pattern: String,
    pub child_patterns: Vec<String>,
}

#[napi(object)]
pub struct ProjectionSettingsJs {
    pub sort_by: String,
    pub case_sensitive: bool,
    pub locale: Option<String>,
    pub folders_on_top: bool,
    pub show_hidden_files: bool,
    pub show_ignored_files: bool,
    pub compact_folders: bool,
    pub exclude_globs: Vec<String>,
    pub file_nesting_rules: Vec<FileNestingRuleJs>,
}

/// Local-mode capability bitmask advertised in Phase 5 wave 1.
/// ReadWrite (1) | CaseSensitive (2) | Watch (32) = 35.
/// Keep in sync with api.d.ts `Capability` when later waves expand.
const LOCAL_CAPABILITIES: u32 = 0b10_0011;

/// Options passed from JS when constructing FileExplorer. Mirrors
/// `ExplorerOptions` in api.d.ts. Optional fields are `Option<T>`.
#[napi(object)]
pub struct ExplorerOptionsJs {
    /// Workspace roots. Each is a `file://` URI — for Phase 5 we accept
    /// absolute filesystem paths as strings and resolve `file://` in TS.
    pub roots: Vec<String>,
    pub respect_ignore: Option<bool>,
    /// "smart" | "true" | "false". Defaults to "smart" when unset.
    pub follow_symlinks: Option<String>,
    pub walker_concurrency: Option<u32>,
    pub watch_debounce_ms: Option<u32>,
    pub compact_folders: Option<bool>,
    pub exclude_globs: Option<Vec<String>>,
    pub snapshot_path: Option<String>,
    pub max_cached_entries: Option<u32>,
    pub sort_by: Option<String>,
    pub case_sensitive: Option<bool>,
    pub locale: Option<String>,
    pub folders_on_top: Option<bool>,
    pub show_hidden_files: Option<bool>,
    pub show_ignored_files: Option<bool>,
    pub file_nesting_rules: Option<Vec<FileNestingRuleJs>>,
}

/// Resolved form of ExplorerOptionsJs with defaults applied.
#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct ResolvedOptions {
    pub respect_ignore: bool,
    pub follow_symlinks: mille_core::SymlinkPolicy,
    pub walker_concurrency: usize,
    pub watch_debounce_ms: u64,
    pub compact_folders: bool,
    pub snapshot_path: Option<PathBuf>,
    pub max_cached_entries: usize,
}

/// The in-process FileExplorer. Phase 5 builds it out method by method.
#[napi]
pub struct FileExplorer {
    pub(crate) store: Arc<EntryStore>,
    pub(crate) watcher: Arc<std::sync::Mutex<Option<Watcher>>>,
    pub(crate) intents: Arc<parking_lot::Mutex<IntentCache>>,
    disposed: AtomicBool,
    pub(crate) roots: Arc<parking_lot::RwLock<Vec<PathBuf>>>,
    pub(crate) options: ResolvedOptions,
    /// Runtime-configurable exclude rules shared by initial/lazy walks and
    /// watcher reconciliation.
    pub(crate) exclude_globs: Arc<parking_lot::RwLock<Vec<String>>>,
    /// Serializes classification against settings changes so a watcher batch
    /// using an old matcher cannot overwrite freshly reclassified entries.
    pub(crate) policy_gate: Arc<parking_lot::Mutex<()>>,
    /// Event fan-out for on('change' | 'event' | 'batch' | ...). Shared
    /// via Arc so background-thread emitters can clone one reference per
    /// producer.
    pub(crate) events: Arc<EventBus>,
}

#[napi]
impl FileExplorer {
    #[napi(constructor)]
    pub fn new(mut options: ExplorerOptionsJs) -> Result<Self> {
        let roots: Vec<PathBuf> = options.roots.iter().map(PathBuf::from).collect();
        if roots.is_empty() {
            return Err(Error::from_reason(
                "FileExplorer requires at least one root",
            ));
        }
        for r in &roots {
            if !r.is_absolute() {
                return Err(Error::from_reason(format!(
                    "root must be absolute: {:?}",
                    r
                )));
            }
        }

        let case_sensitive = options.case_sensitive.unwrap_or(false);
        let file_nesting = mille_core::FileNestingPolicy::new(
            options
                .file_nesting_rules
                .take()
                .unwrap_or_default()
                .into_iter()
                .map(|rule| (rule.parent_pattern, rule.child_patterns)),
            case_sensitive,
        );
        let exclude_globs = options.exclude_globs.take().unwrap_or_default();
        let resolved = ResolvedOptions {
            respect_ignore: options.respect_ignore.unwrap_or(true),
            follow_symlinks: match options.follow_symlinks.as_deref() {
                Some("true") => mille_core::SymlinkPolicy::Always,
                Some("false") => mille_core::SymlinkPolicy::Never,
                _ => mille_core::SymlinkPolicy::Smart,
            },
            walker_concurrency: options
                .walker_concurrency
                .map(|n| n as usize)
                .unwrap_or_else(num_cpus_or_8),
            watch_debounce_ms: options.watch_debounce_ms.unwrap_or(75) as u64,
            compact_folders: options.compact_folders.unwrap_or(true),
            snapshot_path: options.snapshot_path.map(PathBuf::from),
            max_cached_entries: options
                .max_cached_entries
                .map(|n| n as usize)
                .unwrap_or(500_000),
        };

        let sibling_order = mille_core::sort::SiblingOrder::try_new(
            match options.sort_by.as_deref() {
                Some("type") => mille_core::sort::SortBy::Type,
                Some("modified") => mille_core::sort::SortBy::Modified,
                _ => mille_core::sort::SortBy::Name,
            },
            case_sensitive,
            options.folders_on_top.unwrap_or(true),
            options.locale.as_deref(),
        )
        .map_err(fx_error_to_napi)?;
        let visibility = mille_core::VisibilityPolicy {
            show_hidden_files: options.show_hidden_files.unwrap_or(true),
            show_ignored_files: options.show_ignored_files.unwrap_or(true),
        };

        Ok(Self {
            store: Arc::new(EntryStore::with_projection_settings(
                sibling_order,
                visibility,
                resolved.compact_folders,
                file_nesting,
            )),
            watcher: Arc::new(std::sync::Mutex::new(None)),
            intents: Arc::new(parking_lot::Mutex::new(IntentCache::new())),
            disposed: AtomicBool::new(false),
            roots: Arc::new(parking_lot::RwLock::new(roots)),
            options: resolved,
            exclude_globs: Arc::new(parking_lot::RwLock::new(exclude_globs)),
            policy_gate: Arc::new(parking_lot::Mutex::new(())),
            events: Arc::new(EventBus::new()),
        })
    }

    /// Local-mode baseline capabilities. Phase 5 wave 3+ will recompute
    /// this from provider registration once the dispatcher lands.
    #[napi(getter)]
    pub fn capabilities(&self) -> u32 {
        LOCAL_CAPABILITIES
    }

    /// Phase 5.3 replaces with ChangeSet drain + TSFN invocation.
    /// For now: returns the current store tree-version.
    #[napi(js_name = "getTreeVersion")]
    pub fn get_tree_version(&self) -> u32 {
        self.store.tree_version() as u32
    }

    /// Resolve an indexed entry identity to its exact absolute path. This is
    /// an internal fast path used by the TypeScript wrapper for lazy prefetch;
    /// unlike basename reconstruction it is unambiguous across workspace roots.
    #[napi(js_name = "pathForId")]
    pub fn path_for_id(&self, id: i64) -> Option<String> {
        self.store
            .path_for_id(EntryId(id as u64))
            .map(|path| path.to_string_lossy().into_owned())
    }

    /// Resolve an absolute or workspace-relative path through the store's
    /// reverse path index. A path that exists below a configured root but is
    /// not indexed yet is hydrated one ancestor at a time, keeping lazy-mode
    /// reveal work proportional to path depth rather than workspace size.
    /// Relative paths are tested below every configured root; a leading root
    /// folder name is accepted as well.
    #[napi(js_name = "resolvePath")]
    pub async fn resolve_path(&self, path: String) -> Result<Option<i64>> {
        let input = PathBuf::from(path);
        if input
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        {
            return Ok(None);
        }

        let roots = self.roots.read().clone();
        let mut candidates: Vec<(PathBuf, PathBuf)> = Vec::new();
        for root in &roots {
            let candidate = if input.is_absolute() {
                if !input.starts_with(root) {
                    continue;
                }
                input.clone()
            } else if input.components().next().map(|part| part.as_os_str()) == root.file_name() {
                match root.parent() {
                    Some(parent) => parent.join(&input),
                    None => continue,
                }
            } else if input.as_os_str().is_empty() {
                root.clone()
            } else {
                root.join(&input)
            };
            if candidate.starts_with(root) {
                candidates.push((root.clone(), candidate));
            }
        }

        for (root, candidate) in candidates {
            if let Some(entry) = self.store.get_by_path(&candidate) {
                return Ok(Some(entry.id.raw() as i64));
            }

            match tokio::fs::symlink_metadata(&candidate).await {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(fx_error_to_napi(io_to_fx(error, candidate))),
            }

            let mut current = root.clone();
            let mut inserted_ids: Vec<i64> = Vec::new();
            let mut child_set_changed: Vec<i64> = Vec::new();
            let relative = candidate.strip_prefix(&root).map_err(|_| {
                Error::from_reason("resolved path escaped its configured workspace root")
            })?;

            // The root itself may not have been seeded yet (`initialWalk:
            // 'none'`). Insert it first, then hydrate exactly the requested
            // descendant chain.
            let root_name = root
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| root.to_string_lossy().into_owned());
            let root_id = match self.store.get_by_path(&root) {
                Some(entry) => entry.id,
                None => {
                    let entry = stat_to_entry(&root, None, root_name)
                        .await
                        .map_err(fx_error_to_napi)?;
                    self.store
                        .insert(root.clone(), entry)
                        .map_err(fx_error_to_napi)
                        .map(|id| {
                            inserted_ids.push(id.raw() as i64);
                            id
                        })?
                }
            };
            let mut parent_id = Some(root_id);

            for part in relative.components() {
                let Component::Normal(name) = part else {
                    continue;
                };
                current.push(name);
                let id = match self.store.get_by_path(&current) {
                    Some(entry) => entry.id,
                    None => {
                        let entry =
                            stat_to_entry(&current, parent_id, name.to_string_lossy().into_owned())
                                .await
                                .map_err(fx_error_to_napi)?;
                        self.store
                            .insert(current.clone(), entry)
                            .map_err(fx_error_to_napi)
                            .map(|id| {
                                inserted_ids.push(id.raw() as i64);
                                if let Some(parent) = parent_id {
                                    child_set_changed.push(parent.raw() as i64);
                                }
                                id
                            })?
                    }
                };
                parent_id = Some(id);
            }

            if let Some(entry) = self.store.get_by_path(&candidate) {
                if inserted_ids.is_empty() {
                    return Ok(Some(entry.id.raw() as i64));
                }
                let _policy_guard = self.policy_gate.lock();
                self.reclassify_current_excludes()
                    .map_err(fx_error_to_napi)?;
                let version = self.store.tree_version() as u32;
                let notice = || ChangeNoticeJs {
                    tree_version: version,
                    decoration_version: 0,
                    tree_changed: true,
                    decorations_changed: false,
                    changed_ids: inserted_ids.clone(),
                    child_set_changed: child_set_changed.clone(),
                    decoration_changed_ids: Vec::new(),
                    coarse_subtrees: Vec::new(),
                };
                self.events.emit_change(Channel::Change, notice());
                self.events.emit_change(Channel::ChangeTree, notice());
                return Ok(Some(entry.id.raw() as i64));
            }
        }
        Ok(None)
    }

    /// Walk every configured root via `mille_core::walk` + `populate_store`
    /// and seed the EntryStore with the resulting entries. Returns the
    /// total number of entries inserted across all roots.
    ///
    /// `include_root: true` is required so the walk root itself lands in the
    /// store and receives an exact path-index identity. Without the
    /// root-as-entry, descendants cannot be linked to a configured workspace
    /// root and mutations fail with EINVAL.
    ///
    /// Deliberately NOT called in `new()` — construction stays cheap so
    /// consumers can attach sessions before scanning begins. Tests and
    /// host harnesses that need a populated tree (Phase 7.10's two-
    /// client mutation-ordering integration test, for example) call
    /// this explicitly after construction.
    ///
    /// The watcher starts before the walk, and path-idempotent insertion
    /// closes the race between initial scan results and live events.
    #[napi(js_name = "populateFromRoots")]
    pub async fn populate_from_roots(&self) -> Result<u32> {
        use mille_core::{
            populate_store_with_provenance, walk, walk_with_ignore, IgnoreMatcher, WalkOptions,
        };

        self.ensure_watcher()?;
        let _policy_guard = self.policy_gate.lock();
        let exclude_globs = self.exclude_globs.read().clone();
        let roots = self.roots.read().clone();
        let mut total: u32 = 0;
        for root in &roots {
            let options = WalkOptions {
                max_depth: None,
                follow_symlinks: self.options.follow_symlinks,
                include_hidden: true,
                include_root: true,
                parallelism: self.options.walker_concurrency,
            };
            // v0.2 B3: when respect_ignore is on, apply gitignore rules
            // during the walk via process_read_dir. We seed the matcher
            // with the root's own .gitignore (read directly, no walk)
            // so pnpm-style `node_modules/` symlinks are blocked on the
            // very first read_dir call. Nested ignore files are added
            // dynamically inside walk_with_ignore as subdirectories are
            // streamed.
            let use_matcher = self.options.respect_ignore || !exclude_globs.is_empty();
            let walk_result: std::result::Result<_, FxError> = (|| {
                if use_matcher {
                    let mut traversal = IgnoreMatcher::new();
                    let mut repository_ignore = IgnoreMatcher::new();
                    let mut excludes = IgnoreMatcher::new();
                    if self.options.respect_ignore {
                        for name in mille_core::IGNORE_FILE_NAMES {
                            let candidate = root.join(name);
                            if candidate.is_file() {
                                let _ = traversal.add_from_file(&candidate);
                                let _ = repository_ignore.add_from_file(&candidate);
                            }
                        }
                    }
                    add_exclude_globs(&mut traversal, root, &exclude_globs)?;
                    add_exclude_globs(&mut excludes, root, &exclude_globs)?;
                    let w = walk_with_ignore(root, options, &traversal)?;
                    if self.options.respect_ignore {
                        for entry in &w {
                            if entry.path.file_name().is_some_and(|name| {
                                mille_core::IGNORE_FILE_NAMES
                                    .contains(&name.to_string_lossy().as_ref())
                            }) {
                                let _ = repository_ignore.add_from_file(&entry.path);
                            }
                        }
                    }
                    Ok((
                        w,
                        self.options.respect_ignore.then_some(repository_ignore),
                        (!exclude_globs.is_empty()).then_some(excludes),
                    ))
                } else {
                    Ok((walk(root, options)?, None, None))
                }
            })();
            let (walked, repository_ignore, excludes) = match walk_result {
                Ok(result) => result,
                Err(error) if matches!(&error, FxError::Io { .. }) => {
                    self.mark_configured_root_unavailable(root)
                        .map_err(fx_error_to_napi)?;
                    continue;
                }
                Err(error) => return Err(fx_error_to_napi(error)),
            };
            if let Some(walked_root) = walked.iter().find(|entry| entry.path == *root) {
                if let Some(existing) = self.store.get_by_path(root) {
                    if existing.kind == EntryKind::Unavailable {
                        let mut restored = stat_to_entry(root, None, walked_root.name.clone())
                            .await
                            .map_err(fx_error_to_napi)?;
                        restored.is_ignored = repository_ignore
                            .as_ref()
                            .is_some_and(|matcher| matcher.is_ignored(root, true));
                        restored.is_excluded = excludes
                            .as_ref()
                            .is_some_and(|matcher| matcher.is_ignored(root, true));
                        self.store
                            .update(existing.id, restored)
                            .map_err(fx_error_to_napi)?;
                    }
                }
            }
            let new_entries: Vec<_> = walked
                .into_iter()
                .filter(|entry| self.store.get_by_path(&entry.path).is_none())
                .collect();
            let ids = populate_store_with_provenance(
                &self.store,
                root,
                &new_entries,
                repository_ignore.as_ref(),
                excludes.as_ref(),
            )
            .map_err(fx_error_to_napi)?;
            total = total.saturating_add(ids.len() as u32);
        }
        Ok(total)
    }

    /// Re-stat configured roots without walking descendants.
    ///
    /// Missing or inaccessible roots remain visible as `Unavailable` with
    /// stable identity and no stale children. Restored roots keep that id and
    /// become lazy directories again. One public change notice covers the
    /// complete refresh, and the returned version is a synchronization point.
    #[napi(js_name = "refreshWorkspaceRoots")]
    pub async fn refresh_workspace_roots(&self) -> Result<u32> {
        self.ensure_watcher()?;
        let roots = self.roots.read().clone();
        let mut observed = Vec::with_capacity(roots.len());
        for root in &roots {
            let name = root
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| root.to_string_lossy().into_owned());
            let observation = match stat_to_entry(root, None, name).await {
                Ok(entry)
                    if entry.kind == EntryKind::Directory
                        || entry.symlink_target_is_dir == Some(true) =>
                {
                    match tokio::fs::read_dir(root).await {
                        Ok(_) => Ok(entry),
                        Err(error) => Err(io_to_fx(error, root.clone())),
                    }
                }
                other => other,
            };
            observed.push(observation);
        }

        let _policy_guard = self.policy_gate.lock();
        let exclude_matchers = self.current_exclude_matchers().map_err(fx_error_to_napi)?;
        let previous_version = self.store.tree_version();
        let mut changed_ids = Vec::new();
        let mut child_set_changed = Vec::new();
        let mut became_unavailable = Vec::new();
        let mut became_available = Vec::new();
        for (root, observation) in roots.iter().zip(observed) {
            let existing = self.store.get_by_path(root);
            let available = observation.as_ref().is_ok_and(|entry| {
                entry.kind == EntryKind::Directory || entry.symlink_target_is_dir == Some(true)
            });
            if available {
                let mut entry = observation.expect("availability checked above");
                entry.is_excluded = Self::path_is_excluded(root, &entry, &exclude_matchers);
                if let Some(existing) = existing {
                    let was_unavailable = existing.kind == EntryKind::Unavailable;
                    if self
                        .store
                        .update(existing.id, entry)
                        .map_err(fx_error_to_napi)?
                    {
                        changed_ids.push(existing.id);
                    }
                    if was_unavailable {
                        became_available.push(root.clone());
                    }
                } else {
                    let id = self
                        .store
                        .insert(root.clone(), entry)
                        .map_err(fx_error_to_napi)?;
                    changed_ids.push(id);
                    became_available.push(root.clone());
                }
            } else if let Some(existing) = existing {
                let was_available = existing.kind != EntryKind::Unavailable;
                let (_, removed) = self
                    .store
                    .mark_root_unavailable(existing.id)
                    .map_err(fx_error_to_napi)?;
                if was_available {
                    changed_ids.push(existing.id);
                    changed_ids.extend(removed);
                    child_set_changed.push(existing.id);
                    became_unavailable.push(root.clone());
                }
            } else {
                self.mark_configured_root_unavailable(root)
                    .map_err(fx_error_to_napi)?;
                if let Some(inserted) = self.store.get_by_path(root) {
                    changed_ids.push(inserted.id);
                }
                became_unavailable.push(root.clone());
            }
        }

        let ordered_ids: Vec<EntryId> = roots
            .iter()
            .filter_map(|root| self.store.get_by_path(root).map(|entry| entry.id))
            .collect();
        if ordered_ids.len() == roots.len() {
            self.store
                .reorder_roots(&ordered_ids)
                .map_err(fx_error_to_napi)?;
        }

        let watcher_guard = match self.watcher.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(watcher) = watcher_guard.as_ref() {
            let options = mille_core::WatcherOptions {
                recursive: true,
                debounce_ms: Some(self.options.watch_debounce_ms),
            };
            for root in became_unavailable {
                let _ = watcher.unwatch(&root);
            }
            for root in became_available {
                if let Err(error) = watcher.watch(&root, options.clone()) {
                    self.events.emit_warning(WarningPayloadJs {
                        code: "WNOWATCH".into(),
                        detail: Some(format!("failed to watch {}: {error}", root.display())),
                    });
                }
            }
        }
        drop(watcher_guard);

        let version = self.store.tree_version();
        if version != previous_version {
            changed_ids.extend(ordered_ids);
            changed_ids.sort_unstable();
            changed_ids.dedup();
            let notice = || ChangeNoticeJs {
                tree_version: version as u32,
                decoration_version: 0,
                tree_changed: true,
                decorations_changed: false,
                changed_ids: changed_ids.iter().map(|id| id.raw() as i64).collect(),
                child_set_changed: child_set_changed.iter().map(|id| id.raw() as i64).collect(),
                decoration_changed_ids: Vec::new(),
                coarse_subtrees: Vec::new(),
            };
            self.events.emit_change(Channel::Change, notice());
            self.events.emit_change(Channel::ChangeTree, notice());
        }
        Ok(version as u32)
    }

    /// Authoritatively reconcile one known entry against disk.
    ///
    /// Directories reconcile their direct children by default or their complete
    /// known subtree when `recursive` is true. Files reconcile through their
    /// containing directory so atomic replacement, deletion, and metadata
    /// changes all use the same watcher-tested path.
    #[napi(js_name = "resync")]
    pub async fn resync(&self, id: i64, recursive: Option<bool>) -> Result<u32> {
        self.ensure_watcher()?;
        let entry_id = EntryId(id as u64);
        let entry = self.store.get_by_id(entry_id).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "id {} not found in snapshot",
                id
            )))
        })?;
        let path = self.resolve_path_for_id(id)?;
        let directory_like = entry.kind == EntryKind::Directory
            || entry.symlink_target_is_dir == Some(true)
            || entry.parent_id.is_none();
        let (scope, depth) = if directory_like {
            (
                path,
                if recursive.unwrap_or(false) {
                    None
                } else {
                    Some(1)
                },
            )
        } else {
            entry.parent_id.ok_or_else(|| {
                fx_error_to_napi(FxError::InvalidInput(format!(
                    "file id {} has no containing directory",
                    id
                )))
            })?;
            let parent_path = path.parent().map(Path::to_path_buf).ok_or_else(|| {
                fx_error_to_napi(FxError::InvalidInput(format!(
                    "file id {} has no containing directory path",
                    id
                )))
            })?;
            (parent_path, Some(1))
        };

        let _policy_guard = self.policy_gate.lock();
        let previous_version = self.store.tree_version();
        let outcome = crate::watch_runtime::reconcile_directory(
            &self.store,
            &self.watch_config(),
            &scope,
            depth,
        )
        .map_err(fx_error_to_napi)?;
        self.emit_reconcile_notice(previous_version, &outcome);
        Ok(self.store.tree_version() as u32)
    }

    /// Authoritatively reconcile every configured root and all descendants.
    /// One change notice covers the complete operation.
    #[napi(js_name = "resyncWorkspace")]
    pub async fn resync_workspace(&self) -> Result<u32> {
        self.ensure_watcher()?;
        let roots = self.roots.read().clone();
        let _policy_guard = self.policy_gate.lock();
        let previous_version = self.store.tree_version();
        let config = self.watch_config();
        let mut outcome = crate::watch_runtime::ReconcileOutcome::default();
        for root in roots {
            let root_outcome =
                crate::watch_runtime::reconcile_directory(&self.store, &config, &root, None)
                    .map_err(fx_error_to_napi)?;
            outcome.merge(root_outcome);
        }
        self.emit_reconcile_notice(previous_version, &outcome);
        Ok(self.store.tree_version() as u32)
    }

    /// Bounded-depth walk starting at `path`. We filter the walk output
    /// against the current snapshot before calling `populate_store` to avoid
    /// unnecessary updates; the store also enforces path idempotence. This
    /// keeps the method idempotent, which is what the host-side
    /// `setExpanded` handler needs when a client re-expands a folder the
    /// mirror already covers.
    ///
    /// `max_depth: 0` returns only the walk root; `max_depth: 1` returns
    /// the root plus direct children. `None` is unlimited (same as
    /// `populateFromRoots`) but is only reachable from callers that pass
    /// `null` explicitly — the TS wrapper always supplies a bound.
    ///
    /// `include_root: true` surfaces the folder itself as an Entry when
    /// the store doesn't already hold it; the `roots-only` initial-walk
    /// mode in commit B2.2 relies on this to seed each root with a real
    /// Entry record before any children are walked.
    #[napi(js_name = "populateFromPath")]
    pub async fn populate_from_path(
        &self,
        path: String,
        max_depth: Option<u32>,
        include_root: Option<bool>,
    ) -> Result<u32> {
        use mille_core::{
            populate_store_with_provenance, walk, walk_with_ignore, IgnoreMatcher, WalkOptions,
        };

        self.ensure_watcher()?;
        let _policy_guard = self.policy_gate.lock();
        let exclude_globs = self.exclude_globs.read().clone();
        let p = PathBuf::from(&path);
        if !p.is_absolute() {
            return Err(Error::from_reason(format!(
                "path must be absolute: {}",
                path
            )));
        }

        // Only walk inside one of the configured roots. This both protects
        // the store from accidentally picking up out-of-workspace entries
        // and gives `populate_store` a predictable root context.
        let roots = self.roots.read().clone();
        let root = roots
            .iter()
            .find(|r| p == **r || p.starts_with(r))
            .cloned()
            .ok_or_else(|| {
                Error::from_reason(format!("path {:?} is not under any configured root", p))
            })?;

        let options = WalkOptions {
            max_depth: max_depth.map(|n| n as usize),
            follow_symlinks: self.options.follow_symlinks,
            include_hidden: true,
            include_root: include_root.unwrap_or(true),
            parallelism: self.options.walker_concurrency,
        };

        // v0.2 B3: respect_ignore now uses the symlink-aware walker so
        // lazy `setExpanded` walks on a pnpm monorepo don't accidentally
        // descend into the central store.
        let use_matcher = self.options.respect_ignore || !exclude_globs.is_empty();
        let walk_result: std::result::Result<_, FxError> = (|| {
            if use_matcher {
                let mut traversal = IgnoreMatcher::new();
                let mut repository_ignore = IgnoreMatcher::new();
                let mut excludes = IgnoreMatcher::new();
                add_exclude_globs(&mut traversal, &root, &exclude_globs)?;
                add_exclude_globs(&mut excludes, &root, &exclude_globs)?;
                // Seed with every ignore file on the path from the workspace
                // root down to the target directory — a lazy expand at
                // `repo/packages/foo` should still honor `repo/.gitignore`.
                let mut anchor = root.clone();
                for seg in p
                    .strip_prefix(&root)
                    .ok()
                    .into_iter()
                    .flat_map(|r| r.iter())
                {
                    if self.options.respect_ignore {
                        for name in mille_core::IGNORE_FILE_NAMES {
                            let candidate = anchor.join(name);
                            if candidate.is_file() {
                                let _ = traversal.add_from_file(&candidate);
                                let _ = repository_ignore.add_from_file(&candidate);
                            }
                        }
                    }
                    anchor = anchor.join(seg);
                }
                if self.options.respect_ignore {
                    for name in mille_core::IGNORE_FILE_NAMES {
                        let candidate = p.join(name);
                        if candidate.is_file() {
                            let _ = traversal.add_from_file(&candidate);
                            let _ = repository_ignore.add_from_file(&candidate);
                        }
                    }
                }
                let w = walk_with_ignore(&p, options, &traversal)?;
                if self.options.respect_ignore {
                    for entry in &w {
                        if entry.path.file_name().is_some_and(|name| {
                            mille_core::IGNORE_FILE_NAMES.contains(&name.to_string_lossy().as_ref())
                        }) {
                            let _ = repository_ignore.add_from_file(&entry.path);
                        }
                    }
                }
                Ok((
                    w,
                    self.options.respect_ignore.then_some(repository_ignore),
                    (!exclude_globs.is_empty()).then_some(excludes),
                ))
            } else {
                Ok((walk(&p, options)?, None, None))
            }
        })();
        let (walked, repository_ignore, excludes) = match walk_result {
            Ok(result) => result,
            Err(error) if p == root && matches!(&error, FxError::Io { .. }) => {
                self.mark_configured_root_unavailable(&root)
                    .map_err(fx_error_to_napi)?;
                return Ok(0);
            }
            Err(error) => return Err(fx_error_to_napi(error)),
        };
        if p == root {
            if let Some(walked_root) = walked.iter().find(|entry| entry.path == root) {
                if let Some(existing) = self.store.get_by_path(&root) {
                    if existing.kind == EntryKind::Unavailable {
                        let mut restored = stat_to_entry(&root, None, walked_root.name.clone())
                            .await
                            .map_err(fx_error_to_napi)?;
                        restored.is_ignored = repository_ignore
                            .as_ref()
                            .is_some_and(|matcher| matcher.is_ignored(&root, true));
                        restored.is_excluded = excludes
                            .as_ref()
                            .is_some_and(|matcher| matcher.is_ignored(&root, true));
                        self.store
                            .update(existing.id, restored)
                            .map_err(fx_error_to_napi)?;
                    }
                }
            }
        }

        // Avoid rebuilding entries the store already knows about. `insert`
        // independently enforces path idempotence for watcher/walker races.
        let filtered: Vec<_> = walked
            .into_iter()
            .filter(|w| self.store.get_by_path(&w.path).is_none())
            .collect();

        if filtered.is_empty() {
            return Ok(0);
        }

        let ids = populate_store_with_provenance(
            &self.store,
            &root,
            &filtered,
            repository_ignore.as_ref(),
            excludes.as_ref(),
        )
        .map_err(fx_error_to_napi)?;
        Ok(ids.len() as u32)
    }

    /// Capture an immutable view of the tree. The inner Arc is stable
    /// between deltas, so identity comparison holds on the JS side.
    #[napi(js_name = "getSnapshot")]
    pub fn get_snapshot(&self) -> MirrorSnapshot {
        MirrorSnapshot {
            inner: self.store.snapshot(),
        }
    }

    /// Atomically replace display-only settings and reclassify configured
    /// excludes without rebuilding or walking the explorer.
    #[napi(js_name = "updateProjectionSettings")]
    pub fn update_projection_settings(&self, settings: ProjectionSettingsJs) -> Result<u32> {
        let exclude_globs = settings.exclude_globs;
        let _policy_guard = self.policy_gate.lock();
        let excludes_changed = self.exclude_globs.read().as_slice() != exclude_globs.as_slice();
        let exclude_matchers = if excludes_changed {
            let roots = self.roots.read().clone();
            Some(compile_exclude_matchers(&roots, &exclude_globs).map_err(fx_error_to_napi)?)
        } else {
            None
        };
        let previous_version = self.store.tree_version() as u32;
        let sibling_order = mille_core::sort::SiblingOrder::try_new(
            match settings.sort_by.as_str() {
                "type" => mille_core::sort::SortBy::Type,
                "modified" => mille_core::sort::SortBy::Modified,
                _ => mille_core::sort::SortBy::Name,
            },
            settings.case_sensitive,
            settings.folders_on_top,
            settings.locale.as_deref(),
        )
        .map_err(fx_error_to_napi)?;
        let visibility = mille_core::VisibilityPolicy {
            show_hidden_files: settings.show_hidden_files,
            show_ignored_files: settings.show_ignored_files,
        };
        let nesting = mille_core::FileNestingPolicy::new(
            settings
                .file_nesting_rules
                .into_iter()
                .map(|rule| (rule.parent_pattern, rule.child_patterns)),
            settings.case_sensitive,
        );
        let version = if let Some(exclude_matchers) = exclude_matchers.as_ref() {
            self.store.reconfigure_projection_with_exclusions(
                sibling_order,
                visibility,
                settings.compact_folders,
                nesting,
                |path, entry| {
                    exclude_matchers
                        .iter()
                        .filter(|(root, _)| path.starts_with(root))
                        .max_by_key(|(root, _)| root.components().count())
                        .is_some_and(|(_, matcher)| {
                            let directory_like = entry.kind == EntryKind::Directory
                                || entry.symlink_target_is_dir == Some(true);
                            matcher.is_ignored(path, directory_like)
                        })
                },
            )
        } else {
            self.store.reconfigure_projection(
                sibling_order,
                visibility,
                settings.compact_folders,
                nesting,
            )
        } as u32;
        *self.exclude_globs.write() = exclude_globs;
        if version == previous_version {
            return Ok(version);
        }
        let notice = || ChangeNoticeJs {
            tree_version: version,
            decoration_version: 0,
            tree_changed: true,
            decorations_changed: false,
            changed_ids: Vec::new(),
            child_set_changed: Vec::new(),
            decoration_changed_ids: Vec::new(),
            coarse_subtrees: Vec::new(),
        };
        self.events.emit_change(Channel::Change, notice());
        self.events.emit_change(Channel::ChangeTree, notice());
        Ok(version)
    }

    /// Atomically reorder the current workspace roots by stable EntryId.
    ///
    /// The input must be an exact permutation. No filesystem paths or entry
    /// records change; this publishes a new immutable snapshot solely so
    /// local subscribers and remote mirrors observe the new display order.
    #[napi(js_name = "reorderRoots")]
    pub fn reorder_roots(&self, ids: Vec<i64>) -> Result<u32> {
        let roots: Vec<EntryId> = ids.into_iter().map(|id| EntryId(id as u64)).collect();
        let previous_version = self.store.tree_version() as u32;
        let version = self.store.reorder_roots(&roots).map_err(fx_error_to_napi)? as u32;
        if version == previous_version {
            return Ok(version);
        }
        let ordered_paths: Vec<PathBuf> = roots
            .iter()
            .filter_map(|id| self.store.path_for_id(*id))
            .collect();
        if ordered_paths.len() == roots.len() {
            *self.roots.write() = ordered_paths;
        }
        let changed_ids: Vec<i64> = roots.iter().map(|id| id.0 as i64).collect();
        let notice = || ChangeNoticeJs {
            tree_version: version,
            decoration_version: 0,
            tree_changed: true,
            decorations_changed: false,
            changed_ids: changed_ids.clone(),
            child_set_changed: Vec::new(),
            decoration_changed_ids: Vec::new(),
            coarse_subtrees: Vec::new(),
        };
        self.events.emit_change(Channel::Change, notice());
        self.events.emit_change(Channel::ChangeTree, notice());
        Ok(version)
    }

    /// Atomically replace the configured workspace roots in display order.
    ///
    /// New roots are seeded as entries only; descendants hydrate lazily on
    /// expansion. Removed roots lose their complete known subtrees. Inputs are
    /// validated and statted before watcher/store/config state changes.
    #[napi(js_name = "updateWorkspaceRoots")]
    pub async fn update_workspace_roots(&self, roots: Vec<String>) -> Result<u32> {
        if self.disposed.load(Ordering::Acquire) {
            return Err(Error::from_reason("FileExplorer is disposed"));
        }
        let paths: Vec<PathBuf> = roots.into_iter().map(PathBuf::from).collect();
        for path in &paths {
            if !path.is_absolute() {
                return Err(fx_error_to_napi(FxError::InvalidInput(format!(
                    "workspace root must be absolute: {path:?}"
                ))));
            }
        }
        for (index, path) in paths.iter().enumerate() {
            if paths.iter().skip(index + 1).any(|other| {
                path == other
                    || path.starts_with(other.as_path())
                    || other.starts_with(path.as_path())
            }) {
                return Err(fx_error_to_napi(FxError::InvalidInput(
                    "workspace roots must be unique and non-overlapping".into(),
                )));
            }
        }

        let configured_before = self.roots.read().clone();
        let snapshot_before = self.store.snapshot();
        let displayed_before: Vec<PathBuf> = snapshot_before
            .roots()
            .iter()
            .filter_map(|id| self.store.path_for_id(*id))
            .collect();
        if paths == configured_before && paths == displayed_before {
            return Ok(snapshot_before.tree_version() as u32);
        }

        // Filesystem I/O finishes before the policy gate blocks watcher
        // reconciliation. This is also the failure-atomic validation pass.
        let mut prepared = Vec::with_capacity(paths.len());
        for path in &paths {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned());
            let mut entry = stat_to_entry(path, None, name)
                .await
                .map_err(fx_error_to_napi)?;
            if entry.kind != EntryKind::Directory && entry.symlink_target_is_dir != Some(true) {
                let error = std::io::Error::new(
                    std::io::ErrorKind::NotADirectory,
                    "workspace root is not a directory",
                );
                return Err(fx_error_to_napi(io_to_fx(error, path.clone())));
            }
            entry.parent_id = None;
            prepared.push((path.clone(), entry));
        }

        // An already-indexed child cannot also become a root without
        // reparenting the outer workspace. Overlapping roots are intentionally
        // rejected in this slice so identity and navigation paths stay exact.
        for path in &paths {
            if let Some(existing) = self.store.get_by_path(path) {
                if existing.parent_id.is_some() || !snapshot_before.roots().contains(&existing.id) {
                    return Err(fx_error_to_napi(FxError::InvalidInput(format!(
                        "workspace root overlaps an indexed descendant: {path:?}"
                    ))));
                }
            }
        }

        let exclude_globs = self.exclude_globs.read().clone();
        let exclude_matchers =
            compile_exclude_matchers(&paths, &exclude_globs).map_err(fx_error_to_napi)?;
        for (path, entry) in &mut prepared {
            entry.is_excluded = Self::path_is_excluded(path, entry, &exclude_matchers);
        }

        let added_paths: Vec<PathBuf> = paths
            .iter()
            .filter(|path| !configured_before.contains(path))
            .cloned()
            .collect();
        let removed_paths: Vec<PathBuf> = configured_before
            .iter()
            .filter(|path| !paths.contains(path))
            .cloned()
            .collect();
        let watch_options = mille_core::WatcherOptions {
            recursive: true,
            debounce_ms: Some(self.options.watch_debounce_ms),
        };

        let _policy_guard = self.policy_gate.lock();
        let watcher_guard = match self.watcher.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut watched_added: Vec<PathBuf> = Vec::new();
        let mut watched_removed: Vec<PathBuf> = Vec::new();
        if let Some(watcher) = watcher_guard.as_ref() {
            for path in &added_paths {
                if let Err(error) = watcher.watch(path, watch_options.clone()) {
                    for added in &watched_added {
                        let _ = watcher.unwatch(added);
                    }
                    return Err(fx_error_to_napi(error));
                }
                watched_added.push(path.clone());
            }
            for path in &removed_paths {
                if let Err(error) = watcher.unwatch(path) {
                    for removed in &watched_removed {
                        let _ = watcher.watch(removed, watch_options.clone());
                    }
                    for added in &watched_added {
                        let _ = watcher.unwatch(added);
                    }
                    return Err(fx_error_to_napi(error));
                }
                watched_removed.push(path.clone());
            }
        }

        let previous_version = self.store.tree_version() as u32;
        let (version, added_ids, removed_ids) = match self.store.replace_roots(prepared) {
            Ok(result) => result,
            Err(error) => {
                if let Some(watcher) = watcher_guard.as_ref() {
                    for removed in &watched_removed {
                        let _ = watcher.watch(removed, watch_options.clone());
                    }
                    for added in &watched_added {
                        let _ = watcher.unwatch(added);
                    }
                }
                return Err(fx_error_to_napi(error));
            }
        };
        *self.roots.write() = paths;
        drop(watcher_guard);

        let version = version as u32;
        if version == previous_version {
            return Ok(version);
        }
        let current_root_ids: Vec<i64> = self
            .store
            .snapshot()
            .roots()
            .iter()
            .map(|id| id.raw() as i64)
            .collect();
        let mut changed_ids: Vec<i64> = removed_ids
            .iter()
            .chain(added_ids.iter())
            .map(|id| id.raw() as i64)
            .collect();
        changed_ids.extend(current_root_ids);
        changed_ids.sort_unstable();
        changed_ids.dedup();
        let notice = || ChangeNoticeJs {
            tree_version: version,
            decoration_version: 0,
            tree_changed: true,
            decorations_changed: false,
            changed_ids: changed_ids.clone(),
            child_set_changed: Vec::new(),
            decoration_changed_ids: Vec::new(),
            coarse_subtrees: Vec::new(),
        };
        self.events.emit_change(Channel::Change, notice());
        self.events.emit_change(Channel::ChangeTree, notice());
        Ok(version)
    }

    /// Drain the store's pending ChangeSet, atomically resetting it. Called
    /// once per coalescer tick (Phase 7.6) to feed the per-session delta
    /// diff. Empty ChangeSets are cheap — fields are zero-length vecs and
    /// `to_version == from_version`.
    #[napi(js_name = "takePendingChanges")]
    pub fn take_pending_changes(&self) -> ChangeSetJs {
        let cs = self.store.take_pending_changes();
        ChangeSetJs::from_core(&cs)
    }

    /// Create a file or directory under `parent_id`. Phase 5 scope: leaf only.
    #[napi]
    pub async fn create(&self, parent_id: i64, name: String, kind: u8) -> Result<EntryJs> {
        let kind_enum = kind_from_u8(kind).map_err(fx_error_to_napi)?;
        let parent_eid = EntryId(parent_id as u64);

        let parent_path = resolve_entry_path(&self.store, parent_eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "parent id {} not found in snapshot",
                parent_id
            )))
        })?;

        let new_path = parent_path.join(&name);

        match kind_enum {
            EntryKind::Directory => tokio::fs::create_dir(&new_path)
                .await
                .map_err(|e| fx_error_to_napi(io_to_fx(e, new_path.clone())))?,
            EntryKind::File => tokio::fs::write(&new_path, b"")
                .await
                .map_err(|e| fx_error_to_napi(io_to_fx(e, new_path.clone())))?,
            _ => unreachable!("kind_from_u8 already rejected non-File/Directory"),
        }
        self.record_intent(new_path.clone(), IntentKind::Create);

        // Stat and insert into the store.
        let mut entry = stat_to_entry(&new_path, Some(parent_eid), name)
            .await
            .map_err(fx_error_to_napi)?;
        let _policy_guard = self.policy_gate.lock();
        let exclude_matchers = self.current_exclude_matchers().map_err(fx_error_to_napi)?;
        entry.is_excluded = Self::path_is_excluded(&new_path, &entry, &exclude_matchers);
        let new_id = self
            .store
            .insert(new_path, entry)
            .map_err(fx_error_to_napi)?;

        // Re-read the freshly inserted Entry so id/summary state is current.
        let arc = self
            .store
            .get_by_id(new_id)
            .ok_or_else(|| Error::from_reason("insert succeeded but id vanished"))?;
        Ok(EntryJs::from_core(arc.as_ref()))
    }

    /// Rename an entry in place while preserving its identity and any known
    /// descendant identities.
    #[napi]
    pub async fn rename(&self, id: i64, new_name: String) -> Result<EntryJs> {
        let eid = EntryId(id as u64);
        let old_path = resolve_entry_path(&self.store, eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "id {} not found in snapshot",
                id
            )))
        })?;
        let parent_path = old_path.parent().map(|p| p.to_path_buf()).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "cannot rename a root: id {}",
                id
            )))
        })?;
        let new_path = parent_path.join(&new_name);

        tokio::fs::rename(&old_path, &new_path)
            .await
            .map_err(|e| fx_error_to_napi(io_to_fx(e, old_path.clone())))?;
        self.record_intent(old_path.clone(), IntentKind::Rename);
        self.record_intent(new_path.clone(), IntentKind::Rename);

        let _policy_guard = self.policy_gate.lock();
        self.store.rename(eid, new_path).map_err(fx_error_to_napi)?;
        self.reclassify_current_excludes()
            .map_err(fx_error_to_napi)?;

        let arc = self
            .store
            .get_by_id(eid)
            .ok_or_else(|| Error::from_reason("rename succeeded but id vanished"))?;
        Ok(EntryJs::from_core(arc.as_ref()))
    }

    /// Move an entry under a new parent, optionally renaming in flight.
    #[napi(js_name = "move")]
    pub async fn move_entry(
        &self,
        id: i64,
        new_parent_id: i64,
        new_name: Option<String>,
        options: Option<TransferOptionsJs>,
    ) -> Result<EntryJs> {
        let eid = EntryId(id as u64);
        let new_parent_eid = EntryId(new_parent_id as u64);
        let (allow_cross_root, collision) =
            transfer_policy(options.as_ref()).map_err(fx_error_to_napi)?;

        let old_path = resolve_entry_path(&self.store, eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "id {} not found in snapshot",
                id
            )))
        })?;
        let new_parent_path = resolve_entry_path(&self.store, new_parent_eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "new_parent id {} not found in snapshot",
                new_parent_id
            )))
        })?;
        let snapshot = self.store.snapshot();
        let source = snapshot.get(eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "id {} vanished mid-move",
                id
            )))
        })?;
        if source.parent_id.is_none() {
            return Err(fx_error_to_napi(FxError::InvalidInput(
                "workspace roots cannot be moved".into(),
            )));
        }
        let destination_parent = snapshot.get(new_parent_eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "new_parent id {} vanished mid-move",
                new_parent_id
            )))
        })?;
        if destination_parent.kind != EntryKind::Directory
            && destination_parent.symlink_target_is_dir != Some(true)
        {
            return Err(fx_error_to_napi(FxError::InvalidInput(
                "move destination is not a directory".into(),
            )));
        }
        if source.kind == EntryKind::Directory && new_parent_path.starts_with(&old_path) {
            return Err(fx_error_to_napi(FxError::InvalidInput(
                "cannot move a directory into its own subtree".into(),
            )));
        }
        let roots = self.roots.read().clone();
        let source_root = configured_root_for_path(&roots, &old_path);
        let destination_root = configured_root_for_path(&roots, &new_parent_path);
        if source_root != destination_root && !allow_cross_root {
            return Err(fx_error_to_napi(FxError::Unsupported(
                "cross-root move requires { crossRoot: true }".into(),
            )));
        }

        let desired_name = new_name.unwrap_or_else(|| {
            old_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
                .unwrap_or_default()
        });
        if new_parent_path.join(&desired_name) == old_path {
            return Ok(EntryJs::from_core(source.as_ref()));
        }
        let (_, new_path) =
            resolve_transfer_destination(&new_parent_path, &desired_name, collision)
                .await
                .map_err(fx_error_to_napi)?;

        if let Err(error) = tokio::fs::rename(&old_path, &new_path).await {
            if error.raw_os_error() == Some(18) {
                return Err(fx_error_to_napi(FxError::Unsupported(
                    "cross-device move requires copy/delete fallback".into(),
                )));
            }
            return Err(fx_error_to_napi(io_to_fx(error, old_path.clone())));
        }
        self.record_intent(old_path.clone(), IntentKind::Rename);
        self.record_intent(new_path.clone(), IntentKind::Rename);

        let _policy_guard = self.policy_gate.lock();
        if let Err(error) = self.store.rename(eid, new_path.clone()) {
            let _ = tokio::fs::rename(&new_path, &old_path).await;
            return Err(fx_error_to_napi(error));
        }
        self.reclassify_current_excludes()
            .map_err(fx_error_to_napi)?;

        let arc = self
            .store
            .get_by_id(eid)
            .ok_or_else(|| Error::from_reason("move succeeded but id vanished"))?;
        Ok(EntryJs::from_core(arc.as_ref()))
    }

    /// Delete an entry. Directories with children require recursive: true.
    /// `trash` is accepted but currently falls back to permanent delete.
    #[napi]
    pub async fn delete(&self, id: i64, options: Option<DeleteOptionsJs>) -> Result<()> {
        let eid = EntryId(id as u64);
        let recursive = options.as_ref().and_then(|o| o.recursive).unwrap_or(false);

        let snap = self.store.snapshot();
        let path = resolve_entry_path(&self.store, eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "id {} not found in snapshot",
                id
            )))
        })?;
        let entry = snap.get(eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "id {} vanished mid-delete",
                id
            )))
        })?;

        match entry.kind {
            EntryKind::Directory => {
                if snap.has_children(eid) && !recursive {
                    return Err(fx_error_to_napi(FxError::Unsupported(format!(
                        "delete of non-empty directory {:?} requires recursive: true",
                        path
                    ))));
                }
                if recursive {
                    tokio::fs::remove_dir_all(&path)
                        .await
                        .map_err(|e| fx_error_to_napi(io_to_fx(e, path.clone())))?;
                } else {
                    tokio::fs::remove_dir(&path)
                        .await
                        .map_err(|e| fx_error_to_napi(io_to_fx(e, path.clone())))?;
                }
            }
            _ => {
                tokio::fs::remove_file(&path)
                    .await
                    .map_err(|e| fx_error_to_napi(io_to_fx(e, path.clone())))?;
            }
        }
        self.record_intent(path.clone(), IntentKind::Delete);

        if recursive {
            self.store.remove_subtree(eid);
        } else {
            self.store.remove(eid);
        }
        Ok(())
    }

    /// Copy a file under a new parent. Recursive directory copy remains a
    /// later transfer-pipeline feature.
    #[napi]
    pub async fn copy(
        &self,
        id: i64,
        new_parent_id: i64,
        new_name: Option<String>,
        options: Option<TransferOptionsJs>,
    ) -> Result<EntryJs> {
        let eid = EntryId(id as u64);
        let new_parent_eid = EntryId(new_parent_id as u64);
        let (allow_cross_root, collision) =
            transfer_policy(options.as_ref()).map_err(fx_error_to_napi)?;
        let snap = self.store.snapshot();

        let src_path = resolve_entry_path(&self.store, eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "id {} not found in snapshot",
                id
            )))
        })?;
        let new_parent_path = resolve_entry_path(&self.store, new_parent_eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "new_parent id {} not found in snapshot",
                new_parent_id
            )))
        })?;

        let src_entry = snap.get(eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "id {} vanished mid-copy",
                id
            )))
        })?;
        if src_entry.kind == EntryKind::Directory {
            return Err(fx_error_to_napi(FxError::Unsupported(
                "recursive directory copy is not supported yet".into(),
            )));
        }
        let destination_parent = snap.get(new_parent_eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "new_parent id {} vanished mid-copy",
                new_parent_id
            )))
        })?;
        if destination_parent.kind != EntryKind::Directory
            && destination_parent.symlink_target_is_dir != Some(true)
        {
            return Err(fx_error_to_napi(FxError::InvalidInput(
                "copy destination is not a directory".into(),
            )));
        }
        let roots = self.roots.read().clone();
        let source_root = configured_root_for_path(&roots, &src_path);
        let destination_root = configured_root_for_path(&roots, &new_parent_path);
        if source_root != destination_root && !allow_cross_root {
            return Err(fx_error_to_napi(FxError::Unsupported(
                "cross-root copy requires { crossRoot: true }".into(),
            )));
        }

        let desired_name = new_name.unwrap_or_else(|| src_entry.name.clone());
        let (effective_name, dst_path) =
            resolve_transfer_destination(&new_parent_path, &desired_name, collision)
                .await
                .map_err(fx_error_to_napi)?;

        tokio::fs::copy(&src_path, &dst_path)
            .await
            .map_err(|e| fx_error_to_napi(io_to_fx(e, dst_path.clone())))?;
        self.record_intent(dst_path.clone(), IntentKind::Create);

        let mut entry = stat_to_entry(&dst_path, Some(new_parent_eid), effective_name)
            .await
            .map_err(fx_error_to_napi)?;
        let _policy_guard = self.policy_gate.lock();
        let exclude_matchers = self.current_exclude_matchers().map_err(fx_error_to_napi)?;
        entry.is_excluded = Self::path_is_excluded(&dst_path, &entry, &exclude_matchers);
        let new_id = self
            .store
            .insert(dst_path, entry)
            .map_err(fx_error_to_napi)?;

        let arc = self
            .store
            .get_by_id(new_id)
            .ok_or_else(|| Error::from_reason("copy succeeded but id vanished"))?;
        Ok(EntryJs::from_core(arc.as_ref()))
    }

    // ---- File I/O ----------------------------------------------------
    //
    // Each I/O method plumbs a `CancellationToken` through `crate::io`
    // even though the JS-visible surface doesn't yet accept an
    // `AbortSignal` parameter. Reason: napi-rs 3.8's `AbortSignal` is
    // backed by `Rc<RefCell<..>>` and is therefore `!Send`; the
    // `#[napi]` macro wraps `async fn` bodies into `tokio::spawn`-able
    // futures that must be `Send`, so AbortSignal can't appear as a
    // direct parameter. The supported pattern is `AsyncTask` +
    // `Task::with_signal`, which means restructuring these methods
    // around a `Task` impl — that belongs in Phase 6 when the TS
    // wrapper lands and can front a unified signal-aware surface.
    //
    // In the meantime `signal_to_token(None)` yields a never-fires
    // token, so the token checks inside `crate::io` are effectively
    // no-ops but ready to bite once the signal path is wired.
    // SPEC §4.6 flags AbortSignal as advisory in Phase 5.

    /// Read a file's contents by id. Returns a `Buffer` — JS receives a
    /// zero-copy view over the bytes (standard Node builds).
    #[napi(js_name = "readFile")]
    pub async fn read_file(&self, id: i64) -> Result<Buffer> {
        // TODO(phase-6): accept `Option<AbortSignal>` once the wrapper
        // restructures I/O onto `AsyncTask` (napi-rs 3.8 limitation).
        let token = crate::cancel::signal_to_token(None);
        let path = self.resolve_path_for_id(id)?;
        crate::io::read_file(path, token).await
    }

    /// Read a file as text. Only UTF-8 is supported in v0.1; pass
    /// `encoding: "utf-8"` (or omit) — anything else returns EUNSUPPORTED.
    #[napi(js_name = "readText")]
    pub async fn read_text(&self, id: i64, encoding: Option<String>) -> Result<String> {
        let token = crate::cancel::signal_to_token(None);
        let path = self.resolve_path_for_id(id)?;
        crate::io::read_text(path, encoding, token).await
    }

    /// Write `data` to a file by id. When `options.atomic` is true, writes
    /// through a sibling `.mille.tmp` file + rename — safe against partial
    /// writes on same-filesystem targets.
    #[napi(js_name = "writeFile")]
    pub async fn write_file(
        &self,
        id: i64,
        data: Buffer,
        options: Option<WriteFileOptionsJs>,
    ) -> Result<()> {
        let token = crate::cancel::signal_to_token(None);
        let path = self.resolve_path_for_id(id)?;
        let existing = self
            .store
            .get_by_id(EntryId(id as u64))
            .ok_or_else(|| Error::from_reason(format!("id {id} vanished mid-write")))?;
        let atomic = options.and_then(|o| o.atomic).unwrap_or(false);
        crate::io::write_file(path.clone(), data.to_vec(), atomic, token).await?;
        let mut updated = stat_to_entry(&path, existing.parent_id, existing.name.clone())
            .await
            .map_err(fx_error_to_napi)?;
        updated.is_ignored = existing.is_ignored;
        updated.is_excluded = existing.is_excluded;
        updated.path_segments = existing.path_segments.clone();
        self.store
            .update(existing.id, updated)
            .map_err(fx_error_to_napi)?;
        self.record_intent(path, IntentKind::Modify);
        Ok(())
    }

    /// Open a streaming reader. Consumers call `.next()` repeatedly until
    /// it returns null; `.cancel()` tears down early. The Phase 6 TS
    /// wrapper presents this as `AsyncIterable<Uint8Array>`.
    ///
    /// TODO(phase-6 / PLAN 13.x): accept `Option<AbortSignal>` once the
    /// wrapper restructures onto `AsyncTask` — same `!Send` constraint
    /// that defers it on read_file/write_file.
    #[napi(js_name = "readFileStream")]
    pub fn read_file_stream(&self, id: i64) -> Result<crate::stream::FileReadStream> {
        let path = self.resolve_path_for_id(id)?;
        Ok(crate::stream::FileReadStream::open(path))
    }

    // ---- Event subscription ------------------------------------------
    //
    // api.d.ts exposes a single `on(event, listener)` overload set, but
    // napi-rs 3.x requires the ThreadsafeFunction payload type to be
    // known at the FFI boundary (const-generic `CalleeHandled`, typed
    // arg). A single Rust method handling all 8 channels would have to
    // re-create the TSFN via match-on-string from a raw `Function`,
    // which drags in `Env` and leaks the napi-internal builder types.
    //
    // Per-channel `onXxx` methods are simpler and keep payloads typed
    // end-to-end. The Phase 6 TS wrapper unifies them behind the single
    // `on(event, listener)` contract from api.d.ts so JS consumers never
    // see the split surface.

    /// Subscribe to the coalesced `'change'` channel — fires once per
    /// coalescer flush regardless of whether the delta was tree-only,
    /// decoration-only, or both.
    #[napi(js_name = "onChange")]
    pub fn on_change(
        &self,
        listener: ThreadsafeFunction<
            ChangeNoticeJs,
            Unknown<'static>,
            ChangeNoticeJs,
            Status,
            false,
        >,
    ) -> u64 {
        self.events.subscribe_change(Channel::Change, listener)
    }

    /// Subscribe to the `'change:tree'` channel — tree-structural changes only.
    #[napi(js_name = "onChangeTree")]
    pub fn on_change_tree(
        &self,
        listener: ThreadsafeFunction<
            ChangeNoticeJs,
            Unknown<'static>,
            ChangeNoticeJs,
            Status,
            false,
        >,
    ) -> u64 {
        self.events.subscribe_change(Channel::ChangeTree, listener)
    }

    /// Subscribe to the `'change:decorations'` channel — decoration
    /// bumps that don't touch the tree structure.
    #[napi(js_name = "onChangeDecorations")]
    pub fn on_change_decorations(
        &self,
        listener: ThreadsafeFunction<
            ChangeNoticeJs,
            Unknown<'static>,
            ChangeNoticeJs,
            Status,
            false,
        >,
    ) -> u64 {
        self.events
            .subscribe_change(Channel::ChangeDecorations, listener)
    }

    /// Subscribe to the raw single-event stream fed by the live watcher.
    #[napi(js_name = "onEvent")]
    pub fn on_event(
        &self,
        listener: ThreadsafeFunction<
            FileSystemEventJs,
            Unknown<'static>,
            FileSystemEventJs,
            Status,
            false,
        >,
    ) -> u64 {
        self.events.subscribe_event(listener)
    }

    /// Subscribe to the batched event stream. Each emission is a Vec
    /// of events coalesced within one debounce window.
    #[napi(js_name = "onBatch")]
    pub fn on_batch(
        &self,
        listener: ThreadsafeFunction<
            Vec<FileSystemEventJs>,
            Unknown<'static>,
            Vec<FileSystemEventJs>,
            Status,
            false,
        >,
    ) -> u64 {
        self.events.subscribe_batch(listener)
    }

    /// Subscribe to soft warnings — inotify budget advisories, dropped
    /// events, platform quirks. Non-fatal; distinct from `'error'`.
    #[napi(js_name = "onWarning")]
    pub fn on_warning(
        &self,
        listener: ThreadsafeFunction<
            WarningPayloadJs,
            Unknown<'static>,
            WarningPayloadJs,
            Status,
            false,
        >,
    ) -> u64 {
        self.events.subscribe_warning(listener)
    }

    /// Subscribe to the error channel. Engine-side failures (watcher
    /// crash, walker panic) surface here with an ErrorCode + message.
    #[napi(js_name = "onError")]
    pub fn on_error(
        &self,
        listener: ThreadsafeFunction<
            ErrorPayloadJs,
            Unknown<'static>,
            ErrorPayloadJs,
            Status,
            false,
        >,
    ) -> u64 {
        self.events.subscribe_error(listener)
    }

    /// Subscribe to the `'ready'` channel. Fires once when the initial
    /// scan settles; later phases may re-fire on root re-add.
    #[napi(js_name = "onReady")]
    pub fn on_ready(
        &self,
        listener: ThreadsafeFunction<(), Unknown<'static>, (), Status, false>,
    ) -> u64 {
        self.events.subscribe_ready(listener)
    }

    /// Remove the listener registered under `subscription_id`. Returns
    /// true if a listener was actually removed; double-off is idempotent.
    #[napi(js_name = "off")]
    pub fn off(&self, subscription_id: i64) -> bool {
        // `on*` returns u64 but napi widens unsigned 64-bit to JS bigint;
        // the TS wrapper re-narrows to number (we stay < 2^53 in practice
        // since subscription churn is human-scale). Accept i64 here for
        // parity with the rest of the id surface.
        self.events.unsubscribe(subscription_id as u64)
    }

    /// Test-only: emit a synthetic 'ready' so the Wave 7 Node harness can
    /// verify end-to-end delivery without spinning up a real watcher.
    /// Gated under `#[cfg(feature = "test-hooks")]` would be cleaner but
    /// the binding crate is cdylib-only; `pub(crate)` + a thin `#[napi]`
    /// wrapper is enough for the integration tests to reach it.
    #[napi(js_name = "emitReadyForTests")]
    pub fn emit_ready_for_tests(&self) {
        self.events.emit_ready();
    }

    /// Filename fuzzy search via nucleo (Phase 10). Runs synchronously
    /// against a fresh in-memory snapshot. Returns hits sorted by score
    /// descending; ties break on ascending entry id.
    ///
    /// The client-port path (search-over-the-wire) is Phase 10+ and
    /// is not wired here — this method is local-mode only.
    #[napi]
    pub fn search(&self, query: String, options: Option<SearchOptionsJs>) -> Vec<SearchHitJs> {
        let snap = self.store.snapshot();
        let opts = options
            .map(|o| mille_core::SearchOptions {
                limit: o.limit.map(|n| n as usize),
                include_ignored: o.include_ignored.unwrap_or(false),
                case_sensitive: o.case_sensitive.unwrap_or(false),
            })
            .unwrap_or_default();

        let hits = mille_core::search(snap.as_ref(), &query, &opts);
        hits.into_iter()
            .filter_map(|h| {
                // Search only emits ids present in the snapshot's entries,
                // so get() returning None here is a logic bug — skip rather
                // than panic to keep the JS boundary robust on races.
                let entry = snap.get(h.id)?;
                Some(SearchHitJs {
                    entry: EntryJs::from_core(entry.as_ref()),
                    score: h.score as f64,
                    matched_indices: h.matched_indices,
                })
            })
            .collect()
    }

    /// Idempotently stop the watcher and release its forwarding thread.
    #[napi]
    pub async fn dispose(&self) -> Result<()> {
        if self.disposed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let watcher = match self.watcher.lock() {
            Ok(mut guard) => guard.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        // Drop outside the mutex: Watcher::drop joins its forwarding thread.
        drop(watcher);
        Ok(())
    }
}

impl FileExplorer {
    /// Caller holds `policy_gate`.
    fn mark_configured_root_unavailable(
        &self,
        root: &std::path::Path,
    ) -> std::result::Result<u64, FxError> {
        if let Some(existing) = self.store.get_by_path(root) {
            return self
                .store
                .mark_root_unavailable(existing.id)
                .map(|(version, _)| version);
        }
        let name = root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned());
        let id = self.store.insert(
            root.to_path_buf(),
            Entry {
                id: EntryId(0),
                parent_id: None,
                name,
                kind: EntryKind::Unavailable,
                size: 0,
                mtime_ms: 0,
                ctime_ms: 0,
                symlink_target_is_dir: None,
                path_segments: None,
                is_ignored: false,
                is_excluded: false,
                is_readonly: true,
                is_hidden: false,
            },
        )?;
        Ok(self
            .store
            .get_by_id(id)
            .map_or(0, |_| self.store.tree_version()))
    }

    fn current_exclude_matchers(
        &self,
    ) -> std::result::Result<Vec<(PathBuf, mille_core::IgnoreMatcher)>, FxError> {
        compile_exclude_matchers(&self.roots.read(), &self.exclude_globs.read())
    }

    fn path_is_excluded(
        path: &std::path::Path,
        entry: &mille_core::Entry,
        matchers: &[(PathBuf, mille_core::IgnoreMatcher)],
    ) -> bool {
        matchers
            .iter()
            .filter(|(root, _)| path.starts_with(root))
            .max_by_key(|(root, _)| root.components().count())
            .is_some_and(|(_, matcher)| {
                let directory_like =
                    entry.kind == EntryKind::Directory || entry.symlink_target_is_dir == Some(true);
                matcher.is_ignored(path, directory_like)
            })
    }

    /// Caller holds `policy_gate`.
    fn reclassify_current_excludes(&self) -> std::result::Result<u64, FxError> {
        let matchers = self.current_exclude_matchers()?;
        Ok(self
            .store
            .reconfigure_exclusions(|path, entry| Self::path_is_excluded(path, entry, &matchers)))
    }

    fn ensure_watcher(&self) -> Result<()> {
        if self.disposed.load(Ordering::Acquire) {
            return Err(Error::from_reason("FileExplorer is disposed"));
        }
        let mut guard = match self.watcher.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if guard.is_some() {
            return Ok(());
        }
        let watcher = crate::watch_runtime::create_watcher(
            Arc::clone(&self.store),
            Arc::clone(&self.events),
            Arc::clone(&self.intents),
            self.watch_config(),
        )
        .map_err(fx_error_to_napi)?;
        *guard = Some(watcher);
        Ok(())
    }

    fn watch_config(&self) -> crate::watch_runtime::WatchConfig {
        crate::watch_runtime::WatchConfig {
            roots: Arc::clone(&self.roots),
            respect_ignore: self.options.respect_ignore,
            exclude_globs: Arc::clone(&self.exclude_globs),
            policy_gate: Arc::clone(&self.policy_gate),
            follow_symlinks: self.options.follow_symlinks,
            walker_concurrency: self.options.walker_concurrency,
            debounce_ms: self.options.watch_debounce_ms,
        }
    }

    fn emit_reconcile_notice(
        &self,
        previous_version: u64,
        outcome: &crate::watch_runtime::ReconcileOutcome,
    ) {
        let version = self.store.tree_version();
        if version == previous_version && outcome.coarse_ids.is_empty() {
            return;
        }
        let notice = || ChangeNoticeJs {
            tree_version: version as u32,
            decoration_version: 0,
            tree_changed: version != previous_version,
            decorations_changed: false,
            changed_ids: outcome
                .changed_ids
                .iter()
                .map(|id| id.raw() as i64)
                .collect(),
            child_set_changed: outcome
                .child_set_changed
                .iter()
                .map(|id| id.raw() as i64)
                .collect(),
            decoration_changed_ids: Vec::new(),
            coarse_subtrees: outcome
                .coarse_ids
                .iter()
                .map(|id| id.raw() as i64)
                .collect(),
        };
        self.events.emit_change(Channel::Change, notice());
        self.events.emit_change(Channel::ChangeTree, notice());
    }

    fn record_intent(&self, path: PathBuf, kind: IntentKind) {
        self.intents.lock().record(path, kind, Instant::now());
    }

    /// Shared path-resolution helper for read/write and mutation methods.
    /// Returns a ready-to-fx_error EINVAL when the id isn't in the current
    /// snapshot — same shape mutations use, so the TS wrapper can key off
    /// `FX|EINVAL|...` uniformly.
    pub(crate) fn resolve_path_for_id(&self, id: i64) -> Result<std::path::PathBuf> {
        let eid = EntryId(id as u64);
        resolve_entry_path(&self.store, eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "id {} not found in snapshot",
                id
            )))
        })
    }
}

fn add_exclude_globs(
    matcher: &mut mille_core::IgnoreMatcher,
    root: &std::path::Path,
    globs: &[String],
) -> std::result::Result<(), FxError> {
    if globs.is_empty() {
        return Ok(());
    }
    matcher.add_from_string(root, &globs.join("\n"))
}

fn compile_exclude_matchers(
    roots: &[PathBuf],
    globs: &[String],
) -> std::result::Result<Vec<(PathBuf, mille_core::IgnoreMatcher)>, FxError> {
    roots
        .iter()
        .map(|root| {
            let mut matcher = mille_core::IgnoreMatcher::new();
            add_exclude_globs(&mut matcher, root, globs)?;
            Ok((root.clone(), matcher))
        })
        .collect()
}

#[derive(Copy, Clone)]
enum CollisionPolicy {
    Error,
    Rename,
}

fn transfer_policy(
    options: Option<&TransferOptionsJs>,
) -> std::result::Result<(bool, CollisionPolicy), FxError> {
    let cross_root = options
        .and_then(|options| options.cross_root)
        .unwrap_or(false);
    let collision = match options.and_then(|options| options.collision.as_deref()) {
        None | Some("error") => CollisionPolicy::Error,
        Some("rename") => CollisionPolicy::Rename,
        Some(other) => {
            return Err(FxError::InvalidInput(format!(
                "unsupported collision policy: {other}"
            )));
        }
    };
    Ok((cross_root, collision))
}

fn configured_root_for_path(roots: &[PathBuf], path: &Path) -> Option<PathBuf> {
    roots
        .iter()
        .filter(|root| path == root.as_path() || path.starts_with(root))
        .max_by_key(|root| root.components().count())
        .cloned()
}

async fn resolve_transfer_destination(
    parent: &Path,
    desired_name: &str,
    collision: CollisionPolicy,
) -> std::result::Result<(String, PathBuf), FxError> {
    let desired = parent.join(desired_name);
    match tokio::fs::symlink_metadata(&desired).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((desired_name.to_string(), desired));
        }
        Err(error) => return Err(io_to_fx(error, desired)),
        Ok(_) if matches!(collision, CollisionPolicy::Error) => {
            return Err(io_to_fx(
                std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "destination already exists",
                ),
                desired,
            ));
        }
        Ok(_) => {}
    }

    let desired_path = Path::new(desired_name);
    let stem = desired_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(desired_name);
    let extension = desired_path
        .extension()
        .and_then(|extension| extension.to_str());
    for suffix in 1..=10_000u32 {
        let copy_suffix = if suffix == 1 {
            " copy".to_string()
        } else {
            format!(" copy {suffix}")
        };
        let candidate_name = match extension {
            Some(extension) => format!("{stem}{copy_suffix}.{extension}"),
            None => format!("{stem}{copy_suffix}"),
        };
        let candidate = parent.join(&candidate_name);
        match tokio::fs::symlink_metadata(&candidate).await {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((candidate_name, candidate));
            }
            Err(error) => return Err(io_to_fx(error, candidate)),
            Ok(_) => {}
        }
    }
    Err(FxError::InvalidInput(
        "could not allocate a collision-free destination name".into(),
    ))
}

/// Mirror of api.d.ts `WriteFileOptions`.
#[napi(object)]
pub struct WriteFileOptionsJs {
    /// When true, write to a sibling temp file and rename into place.
    pub atomic: Option<bool>,
}

/// SPEC §4.3 caps the walker budget at 8 threads. `std` has no num_cpus,
/// so approximate via `available_parallelism`.
fn num_cpus_or_8() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
}
