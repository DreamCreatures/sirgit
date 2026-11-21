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
    Ok(Json(repo::quickstatus(&q.path)))
}

#[derive(Deserialize)]
pub struct InitParams {
    pub path: String,
    #[serde(default)]
    pub bare: bool,
}

pub async fn init(State(_app): State<Arc<AppState>>, Json(p): Json<InitParams>) -> ApiResult<Json<serde_json::Value>> {
    let path = PathBuf::from(&p.path);
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
    std::fs::create_dir_all(&p.path).map_err(ApiError::Io)?;
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
    let dir = PathBuf::from(&p.path);
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
    let op = op.lock().await.clone();
    Ok(Json(op))
}
