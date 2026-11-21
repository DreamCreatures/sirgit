use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;

use crate::api::repo::PathQuery;
use crate::error::{ApiError, ApiResult};
use crate::gitx::detail::{commit_detail, commit_file_diff, worktree_file_diff};
use crate::state::AppState;

pub async fn detail(
    State(app): State<Arc<AppState>>,
    AxumPath(sha): AxumPath<String>,
    Query(q): Query<PathQuery>,
) -> ApiResult<Json<crate::gitx::detail::CommitDetail>> {
    let _ = app.repo_state(&q.path);
    let d = commit_detail(&q.path, &sha).await.map_err(ApiError::Git)?;
    Ok(Json(d))
}

#[derive(Deserialize)]
pub struct FileDiffQuery {
    pub path: String,
    pub file: String,
}

pub async fn file_diff(
    AxumPath(sha): AxumPath<String>,
    Query(q): Query<FileDiffQuery>,
) -> ApiResult<impl IntoResponse> {
    let text = commit_file_diff(&q.path, &sha, &q.file)
        .await
        .map_err(ApiError::Git)?;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8".to_string())],
        text,
    ))
}

#[derive(Deserialize)]
pub struct WorktreeDiffQuery {
    pub path: String,
    pub file: String,
    #[serde(default)]
    pub staged: bool,
}

pub async fn worktree_diff(Query(q): Query<WorktreeDiffQuery>) -> ApiResult<impl IntoResponse> {
    let text = worktree_file_diff(&q.path, &q.file, q.staged)
        .await
        .map_err(ApiError::Git)?;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8".to_string())],
        text,
    ))
}
