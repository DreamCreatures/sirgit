use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::ops::{locked, ok_json};
use crate::api::repo::PathQuery;
use crate::error::{ApiError, ApiResult};
use crate::gitx::stash as gx_stash;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct StashFilesQuery {
    path: String,
    index: u32,
}

pub async fn list(
    State(app): State<Arc<AppState>>,
    Query(q): Query<PathQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    app.repo_state(&q.path).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let stashes = gx_stash::list(&q.path).await.map_err(ApiError::Git)?;
    Ok(Json(json!({ "stashes": stashes })))
}

pub async fn files(
    State(app): State<Arc<AppState>>,
    Query(q): Query<StashFilesQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    app.repo_state(&q.path).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let files = gx_stash::files(&q.path, q.index).await.map_err(ApiError::Git)?;
    Ok(Json(json!({ "files": files })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashPushParams {
    pub path: String,
    pub message: Option<String>,
}

pub async fn push(State(app): State<Arc<AppState>>, Json(p): Json<StashPushParams>) -> ApiResult<Json<serde_json::Value>> {
    let (st, _g) = locked(&app, &p.path).await?;
    gx_stash::push(&p.path, p.message.as_deref()).await.map_err(ApiError::Git)?;
    st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashApplyParams {
    pub path: String,
    pub index: u32,
    pub pop: bool,
}

pub async fn apply(State(app): State<Arc<AppState>>, Json(p): Json<StashApplyParams>) -> ApiResult<Json<serde_json::Value>> {
    let (st, _g) = locked(&app, &p.path).await?;
    gx_stash::apply(&p.path, p.index, p.pop).await.map_err(ApiError::Git)?;
    st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashDropParams {
    pub path: String,
    pub index: u32,
}

pub async fn drop(State(app): State<Arc<AppState>>, Json(p): Json<StashDropParams>) -> ApiResult<Json<serde_json::Value>> {
    let (st, _g) = locked(&app, &p.path).await?;
    gx_stash::drop(&p.path, p.index).await.map_err(ApiError::Git)?;
    st.bump(&["refs"]);
    Ok(ok_json())
}
