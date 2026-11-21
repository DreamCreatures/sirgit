use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Serialize;

use crate::api::repo::PathQuery;
use crate::error::{ApiError, ApiResult};
use crate::gitx::status::{read_status, StatusSnapshot};
use crate::state::{AppState, StatusCache};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResponse {
    pub revision: u64,
    #[serde(flatten)]
    pub status: StatusSnapshot,
}

pub async fn status(
    State(app): State<Arc<AppState>>,
    Query(q): Query<PathQuery>,
) -> ApiResult<Json<StatusResponse>> {
    let st = app.repo_state(&q.path).map_err(|e| ApiError::BadRequest(e.to_string()))?;

    let mut cache_guard = st.status_cache.lock().await;
    let current = st.current_revision();
    let needs_rebuild = match cache_guard.as_ref() {
        Some(c) => c.revision < current,
        None => true,
    };
    if needs_rebuild {
        let status = read_status(&q.path).await.map_err(ApiError::Git)?;
        *cache_guard = Some(StatusCache { revision: current, status });
    }
    let cache = cache_guard.as_ref().expect("status cache just built");

    Ok(Json(StatusResponse {
        revision: st.current_revision(),
        status: cache.status.clone(),
    }))
}
