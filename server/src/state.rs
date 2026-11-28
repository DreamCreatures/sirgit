use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::broadcast;

use crate::config::SirgitConfig;
use crate::credentials::CredentialsRegistry;
use crate::gitx::log::Row;
use crate::gitx::status::StatusSnapshot;
use crate::watch;

/// Events pushed to WebSocket subscribers of a repo.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RepoEvent {
    Changed {
        revision: u64,
        kinds: Vec<String>,
    },
    OpProgress {
        #[serde(rename = "opId")]
        op_id: String,
        op: String,
        text: String,
        done: Option<bool>,
    },
    CredentialsRequest {
        #[serde(rename = "opId")]
        op_id: String,
        remote: String,
    },
}

#[derive(Debug)]
pub struct TopoCache {
    pub revision: u64,
    pub rows: Vec<Row>,
    /// Previous revision's rows, retained for one revision so clients can sync deltas.
    pub prev_rows: Option<Vec<Row>>,
    pub prev_revision: Option<u64>,
}

#[derive(Debug)]
pub struct StatusCache {
    pub revision: u64,
    pub status: StatusSnapshot,
}

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpState {
    pub op: String,
    /// repo path the op runs in (empty for global ops like clone)
    pub path: String,
    pub status: String, // running | done | error
    pub progress: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
    /// set while git is waiting on the credentials helper — clone has no repo
    /// room, so the poller (not a WS event) raises the credentials modal
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials_remote: Option<String>,
}

pub struct RepoState {
    pub path: PathBuf,
    /// Serialize all mutating operations per repo (reads run concurrently).
    pub write_lock: Arc<tokio::sync::Mutex<()>>,
    pub topo: tokio::sync::Mutex<Option<TopoCache>>,
    pub status_cache: tokio::sync::Mutex<Option<StatusCache>>,
    pub revision: AtomicU64,
    pub events: broadcast::Sender<RepoEvent>,
    #[allow(dead_code)] // consumed by M2 auto-fetch dedupe
    pub fetched_once: AtomicBool,
    pub watcher: Mutex<Option<watch::WatcherHandle>>,
    pub watching: AtomicBool,
}

impl RepoState {
    fn new(path: PathBuf) -> Arc<Self> {
        let (tx, _) = broadcast::channel(256);
        Arc::new(Self {
            path,
            write_lock: Arc::new(tokio::sync::Mutex::new(())),
            topo: tokio::sync::Mutex::new(None),
            status_cache: tokio::sync::Mutex::new(None),
            revision: AtomicU64::new(1),
            events: tx,
            fetched_once: AtomicBool::new(false),
            watcher: Mutex::new(None),
            watching: AtomicBool::new(false),
        })
    }

    pub fn current_revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }

    /// Bump the repo revision and broadcast a change event.
    pub fn bump(&self, kinds: &[&str]) -> u64 {
        let rev = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.events.send(RepoEvent::Changed {
            revision: rev,
            kinds: kinds.iter().map(|s| s.to_string()).collect(),
        });
        rev
    }

    pub fn send_event(&self, ev: RepoEvent) {
        let _ = self.events.send(ev);
    }
}

pub struct AppState {
    pub config: SirgitConfig,
    repos: Mutex<HashMap<PathBuf, Arc<RepoState>>>,
    pub ops: Mutex<HashMap<String, Arc<tokio::sync::Mutex<OpState>>>>,
    pub creds: CredentialsRegistry,
}

impl AppState {
    pub fn new(config: SirgitConfig) -> Self {
        Self {
            config,
            repos: Mutex::new(HashMap::new()),
            ops: Mutex::new(HashMap::new()),
            creds: CredentialsRegistry::new(),
        }
    }

    /// Get or create per-repo state; starts the file watcher on first touch.
    pub fn repo_state(&self, path: &str) -> anyhow::Result<Arc<RepoState>> {
        // canonicalize so watcher event paths (which the OS resolves through
        // symlinks, e.g. /tmp → /private/tmp on macOS) match our repo root
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| Path::new(path).to_path_buf());
        let mut repos = self.repos.lock().unwrap();
        if let Some(existing) = repos.get(&canonical) {
            return Ok(existing.clone());
        }
        let st = RepoState::new(canonical.clone());
        repos.insert(canonical, st.clone());
        drop(repos);
        watch::ensure_watching(self, st.clone());
        Ok(st)
    }

    pub fn start_op(&self, op: &str, path: &str) -> (String, Arc<tokio::sync::Mutex<OpState>>) {
        let id = format!("op-{}-{}", now_ms(), rand_short());
        let state = Arc::new(tokio::sync::Mutex::new(OpState {
            op: op.to_string(),
            path: path.to_string(),
            status: "running".into(),
            progress: Vec::new(),
            error: None,
            credentials_remote: None,
        }));
        self.ops.lock().unwrap().insert(id.clone(), state.clone());
        (id, state.clone())
    }

    pub fn get_op(&self, id: &str) -> Option<Arc<tokio::sync::Mutex<OpState>>> {
        self.ops.lock().unwrap().get(id).cloned()
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn rand_short() -> u32 {
    now_ms() as u32 % 100_000
}
