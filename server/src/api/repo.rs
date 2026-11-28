use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::Json;
use serde::Deserialize;

use crate::error::{ApiError, ApiResult};
use crate::gitx::ops;
use crate::gitx::repo;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct PathQuery {
    pub path: String,
}

pub async fn quickstatus(Query(q): Query<PathQuery>) -> ApiResult<Json<repo::QuickStatus>> {
    Ok(Json(repo::quickstatus(&repo::expand_home(&q.path))))
}

#[derive(Deserialize)]
pub struct InitParams {
    pub path: String,
    #[serde(default)]
    pub bare: bool,
}

pub async fn init(State(_app): State<Arc<AppState>>, Json(p): Json<InitParams>) -> ApiResult<Json<serde_json::Value>> {
    let path = PathBuf::from(repo::expand_home(&p.path));
    ops::init_repo(&path, p.bare)
        .await
        .map_err(ApiError::Git)?;
    Ok(Json(serde_json::json!({})))
}

#[derive(Deserialize)]
pub struct CreateDirParams {
    pub path: String,
}

pub async fn createdir(Json(p): Json<CreateDirParams>) -> ApiResult<Json<serde_json::Value>> {
    let path = repo::expand_home(&p.path);
    std::fs::create_dir_all(&path).map_err(ApiError::Io)?;
    Ok(Json(serde_json::json!({})))
}

#[derive(Deserialize)]
pub struct CloneParams {
    pub url: String,
    pub path: String,
    #[serde(default)]
    pub recurse_submodules: bool,
}

pub async fn clone(State(app): State<Arc<AppState>>, Json(p): Json<CloneParams>) -> ApiResult<Json<serde_json::Value>> {
    let dir = PathBuf::from(repo::expand_home(&p.path));
    if dir.exists() && std::fs::read_dir(&dir).map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Err(ApiError::BadRequest(format!("directory not empty: {}", p.path)));
    }
    let (op_id, op_state) = app.start_op("clone", "");
    let port = app.config.port;
    let url = p.url.clone();
    let recurse = p.recurse_submodules;

    // register credentials before spawning so the helper GET finds a pending entry
    app.creds.register(&op_id, &url);
    // clone target has no repo room yet; progress reaches the client by polling /api/ops/{id}

    let app2 = app.clone();
    let op_id2 = op_id.clone();
    let op2 = op_state.clone();
    tokio::spawn(async move {
        let result = ops::clone_repo(&url, &dir, recurse, port, &op_id2).await;
        let mut op = op2.lock().await;
        match result {
            Ok(()) => {
                op.status = "done".into();
            }
            Err(e) => {
                op.status = "error".into();
                op.error = Some(serde_json::to_value(&e).unwrap_or_default());
            }
        }
        app2.creds.remove(&op_id2);
    });

    Ok(Json(serde_json::json!({ "opId": op_id })))
}

pub async fn op_status(
    State(app): State<Arc<AppState>>,
    AxumPath(op_id): AxumPath<String>,
) -> ApiResult<Json<crate::state::OpState>> {
    let Some(op) = app.get_op(&op_id) else {
        return Err(ApiError::NotFound(format!("unknown op {}", op_id)));
    };
    let mut op = op.lock().await.clone();
    // a pending credentials request rides the op status so CLONE (no repo
    // room → no WS event) can still raise the credentials modal
    if let Some(pending) = app.creds.get(&op_id) {
        op.credentials_remote = Some(pending.remote.clone());
    }
    Ok(Json(op))
}

/// One pickable child directory of a path (home-page path autocomplete).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// the directory is a git worktree (has a .git child) — shows the repo badge
    pub git: bool,
}

/// `GET /api/fs/list?path=` — child DIRECTORIES of a path (hidden included,
/// symlinked dirs followed), case-insensitively sorted, capped at 500.
/// Drives the ungit-style sibling autocomplete on the home page's path input.
pub async fn fs_list(Query(q): Query<PathQuery>) -> ApiResult<Json<Vec<DirEntry>>> {
    Ok(Json(list_dirs(&repo::expand_home(&q.path)).map_err(ApiError::Io)?))
}

fn list_dirs(dir: &str) -> std::io::Result<Vec<DirEntry>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        // metadata (not file_type) follows symlinks — a linked repo is pickable
        let is_dir = std::fs::metadata(entry.path()).map(|m| m.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        out.push(DirEntry {
            git: entry.path().join(".git").exists(),
            name: entry.file_name().to_string_lossy().into_owned(),
        });
        if out.len() >= 500 {
            break;
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_child_dirs_sorted_with_git_flags() {
        let dir = std::env::temp_dir().join(format!("sirgit-fslist-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()));
        std::fs::create_dir_all(dir.join("Beta")).unwrap();
        std::fs::create_dir_all(dir.join("alpha")).unwrap();
        std::fs::create_dir_all(dir.join("alpha/.git")).unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join("file.txt"), "x").unwrap();
        let entries = list_dirs(dir.to_str().unwrap()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec![".hidden", "alpha", "Beta"], "case-insensitive sort, dirs only");
        assert!(entries.iter().find(|e| e.name == "alpha").unwrap().git);
        assert!(!entries.iter().find(|e| e.name == "Beta").unwrap().git);
        assert!(list_dirs("/no/such/dir").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
