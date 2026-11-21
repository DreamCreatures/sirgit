//! Repo file watching. Only `.git` internals + the worktree are watched,
//! coalesced into a single debounced change event (fixes ungit's per-event storms).

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use tokio::sync::broadcast;

use crate::gitx::repo::resolve_repo_paths;
use crate::state::{AppState, RepoEvent, RepoState};

/// Holds the live watcher; dropping it stops watching.
pub struct WatcherHandle {
    _watcher: notify::RecommendedWatcher,
}

/// Ensure a repo is being watched (idempotent).
pub fn ensure_watching(_app: &AppState, st: Arc<RepoState>) {
    if st.watching.swap(true, Ordering::SeqCst) {
        return; // already watching
    }
    let (worktree, git_dir) = match resolve_repo_paths(&st.path.to_string_lossy()) {
        Ok(v) => v,
        Err(_) => {
            st.watching.store(false, Ordering::SeqCst);
            return;
        }
    };

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(_) => {
            st.watching.store(false, Ordering::SeqCst);
            return;
        }
    };

    let _ = watcher.watch(&git_dir.join("HEAD"), RecursiveMode::NonRecursive);
    let _ = watcher.watch(&git_dir.join("index"), RecursiveMode::NonRecursive);
    let _ = watcher.watch(&git_dir.join("refs"), RecursiveMode::Recursive);
    let _ = watcher.watch(&git_dir.join("logs"), RecursiveMode::Recursive);
    let _ = watcher.watch(&git_dir.join("MERGE_HEAD"), RecursiveMode::NonRecursive);
    let _ = watcher.watch(&git_dir.join("CHERRY_PICK_HEAD"), RecursiveMode::NonRecursive);
    let _ = watcher.watch(&worktree, RecursiveMode::Recursive);

    *st.watcher.lock().unwrap() = Some(WatcherHandle { _watcher: watcher });

    let repo_for_thread = st.clone();
    std::thread::spawn(move || {
        coalesce_loop(rx, repo_for_thread);
    });
}

/// Collect notify events and emit one debounced RepoEvent per quiet period.
fn coalesce_loop(rx: mpsc::Receiver<notify::Result<notify::Event>>, st: Arc<RepoState>) {
    let git_dir_prefix = st.path.join(".git");
    let pending_kinds: Mutex<Vec<String>> = Mutex::new(Vec::new());

    loop {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(Ok(event)) => {
                let mut kinds = pending_kinds.lock().unwrap();
                for p in event.paths.iter() {
                    if let Some(k) = classify_path(p, &st.path, &git_dir_prefix) {
                        if !kinds.contains(&k) {
                            kinds.push(k);
                        }
                    }
                }
                // keep the channel drained, classifying anything else that queued up
                while let Ok(more) = rx.try_recv() {
                    if let Ok(ev) = more {
                        for p in ev.paths.iter() {
                            if let Some(k) = classify_path(p, &st.path, &git_dir_prefix) {
                                if !kinds.contains(&k) {
                                    kinds.push(k);
                                }
                            }
                        }
                    }
                }
            }
            Ok(Err(_)) => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let kinds = {
                    let mut k = pending_kinds.lock().unwrap();
                    let taken = k.clone();
                    k.clear();
                    taken
                };
                if !kinds.is_empty() {
                    st.bump(&kinds.iter().map(|s| s.as_str()).collect::<Vec<_>>());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return; // watcher dropped, repo closed
            }
        }
    }
}

fn classify_path(p: &Path, repo_root: &Path, git_dir_prefix: &Path) -> Option<String> {
    let ps = p.to_string_lossy();
    // ignore our own noise + common heavy dirs
    if ps.contains("/node_modules/") || ps.contains("/target/") || ps.contains("/.DS_Store") {
        return None;
    }
    if ps.starts_with(&git_dir_prefix.to_string_lossy().as_ref()) || ps.contains("/.git/") {
        if ps.contains("/refs/") || ps.ends_with("/HEAD") || ps.contains("/logs/") {
            return Some("refs".into());
        }
        if ps.ends_with("/index") || ps.ends_with("MERGE_HEAD") || ps.ends_with("CHERRY_PICK_HEAD") || ps.ends_with("REBASE_HEAD") {
            return Some("index".into());
        }
        return Some("refs".into()); // other .git internals: safest to refresh refs+log
    }
    if p.starts_with(repo_root) {
        return Some("worktree".into());
    }
    None
}

#[allow(dead_code)]
fn unused_broadcast_helper(_tx: &broadcast::Sender<RepoEvent>) {}
