use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Serialize;

use crate::api::repo::PathQuery;
use crate::error::{ApiError, ApiResult};
use crate::gitx::refs::{read_refs, RefsSnapshot};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsResponse {
    pub revision: u64,
    #[serde(flatten)]
    pub snapshot: RefsSnapshot,
}

pub async fn refs(
    State(app): State<Arc<AppState>>,
    Query(q): Query<PathQuery>,
) -> ApiResult<Json<RefsResponse>> {
    let st = app.repo_state(&q.path).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let snapshot = read_refs(&q.path).await.map_err(ApiError::Git)?;
    Ok(Json(RefsResponse {
        revision: st.current_revision(),
        snapshot,
    }))
}
