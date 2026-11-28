//! Credentials flow: git network ops run with an inline credential-helper that
//! GETs /api/credentials?op=<id>; the server notifies the UI over WebSocket;
//! the UI POSTs /api/credentials-response; the helper's GET resolves.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;

pub struct PendingCred {
    pub remote: String,
    pub notify: Arc<Notify>,
    pub creds: Mutex<Option<(String, String)>>,
    pub cancelled: AtomicBool,
}

pub struct CredentialsRegistry {
    pending: Mutex<HashMap<String, Arc<PendingCred>>>,
    /// credentials remembered per remote (remote NAME for repo ops, full URL
    /// for clones) so every subsequent fetch/push/pull in this session runs
    /// without re-prompting. Memory-only by design — nothing touches the
    /// keychain or disk.
    stored: Mutex<HashMap<String, (String, String)>>,
}

impl CredentialsRegistry {
    pub fn new() -> Self {
        Self { pending: Mutex::new(HashMap::new()), stored: Mutex::new(HashMap::new()) }
    }

    pub fn register(&self, op_id: &str, remote: &str) {
        self.pending.lock().unwrap().insert(
            op_id.to_string(),
            Arc::new(PendingCred {
                remote: remote.to_string(),
                notify: Arc::new(Notify::new()),
                creds: Mutex::new(None),
                cancelled: AtomicBool::new(false),
            }),
        );
    }

    pub fn get(&self, op_id: &str) -> Option<Arc<PendingCred>> {
        self.pending.lock().unwrap().get(op_id).cloned()
    }

    /// Previously-answered credentials for this remote (this session).
    pub fn stored_for(&self, remote: &str) -> Option<(String, String)> {
        self.stored.lock().unwrap().get(remote).cloned()
    }

    pub fn store(&self, remote: &str, username: &str, password: &str) {
        if username.is_empty() || password.is_empty() {
            return;
        }
        self.stored
            .lock()
            .unwrap()
            .insert(remote.to_string(), (username.to_string(), password.to_string()));
    }

    pub fn resolve(&self, op_id: &str, username: &str, password: &str) -> bool {
        let Some(p) = self.get(op_id) else { return false };
        *p.creds.lock().unwrap() = Some((username.to_string(), password.to_string()));
        // remember for the session — the next op on this remote skips the modal
        self.store(&p.remote, username, password);
        p.notify.notify_waiters();
        true
    }

    pub fn cancel(&self, op_id: &str) -> bool {
        let Some(p) = self.get(op_id) else { return false };
        p.cancelled.store(true, Ordering::SeqCst);
        p.notify.notify_waiters();
        true
    }

    /// Block until credentials arrive, the request is cancelled, or timeout.
    pub async fn wait(&self, op_id: &str, timeout: Duration) -> Option<(String, String)> {
        let Some(p) = self.get(op_id) else { return None };
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            {
                let creds = p.creds.lock().unwrap().clone();
                if let Some(c) = creds {
                    return Some(c);
                }
                if p.cancelled.load(Ordering::SeqCst) {
                    return None;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            let _ = tokio::time::timeout(Duration::from_millis(500), p.notify.notified()).await;
        }
    }

    pub fn remove(&self, op_id: &str) {
        self.pending.lock().unwrap().remove(op_id);
    }
}
