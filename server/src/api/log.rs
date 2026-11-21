use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::gitx::log::{build_rows, compute_delta, Row};
use crate::state::{AppState, RepoState, TopoCache};

#[derive(Deserialize)]
pub struct LogQuery {
    pub path: String,
    #[serde(default)]
    pub offset: u64,
    pub limit: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub revision: u64,
    pub offset: u64,
    pub total: u64,
    pub rows: Vec<Row>,
}

/// Windowed log page. Pages are disjoint for a fixed revision — the client
/// appends them without re-fetching anything (ungit refetched ever-growing windows).
pub async fn log_page(
    State(app): State<Arc<AppState>>,
    Query(q): Query<LogQuery>,
) -> ApiResult<Json<LogPage>> {
    let st = app.repo_state(&q.path).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let limit = q.limit.unwrap_or(app.config.page_size as u64).max(1);
    let offset = q.offset;

    let mut topo = st.topo.lock().await;
    let cache = ensure_topo(&mut topo, st.as_ref(), &q.path).await?;
    let rows: Vec<Row> = cache
        .rows
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .cloned()
        .collect();
    Ok(Json(LogPage {
        revision: st.current_revision(),
        offset,
        total: cache.rows.len() as u64,
        rows,
    }))
}

#[derive(Deserialize)]
pub struct DeltaQuery {
    pub path: String,
    #[serde(rename = "fromRev")]
    pub from_rev: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaResponse {
    pub revision: u64,
    /// false: client already up to date
    pub changed: bool,
    /// true: client must discard and refetch from offset 0 (too many revisions missed)
    pub reset: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<Vec<Row>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<Vec<String>>,
}

/// Incremental sync: what changed since `fromRev`. O(delta) network instead of
/// ungit's "refetch everything" — the core of the big-repo fix.
pub async fn log_delta(
    State(app): State<Arc<AppState>>,
    Query(q): Query<DeltaQuery>,
) -> ApiResult<Json<DeltaResponse>> {
    let st = app.repo_state(&q.path).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let current = st.current_revision();

    if q.from_rev >= current {
        return Ok(Json(DeltaResponse {
            revision: current,
            changed: false,
            reset: None,
            added: None,
            removed: None,
        }));
    }

    let mut topo = st.topo.lock().await;
    let cache = ensure_topo(&mut topo, st.as_ref(), &q.path).await?;

    if cache.prev_rows.is_none() || cache.prev_revision != Some(q.from_rev) {
        return Ok(Json(DeltaResponse {
            revision: st.current_revision(),
            changed: true,
            reset: Some(true),
            added: None,
            removed: None,
        }));
    }

    let delta = compute_delta(cache.prev_rows.as_ref().unwrap(), &cache.rows);
    Ok(Json(DeltaResponse {
        revision: st.current_revision(),
        changed: true,
        reset: None,
        added: Some(delta.added),
        removed: Some(delta.removed),
    }))
}

/// Rebuild the topology cache if the repo revision moved (single-flight under
/// the topo mutex; previous rows retained for exactly one revision).
pub async fn ensure_topo<'a>(
    topo: &'a mut tokio::sync::MutexGuard<'_, Option<TopoCache>>,
    st: &RepoState,
    path: &str,
) -> ApiResult<&'a TopoCache> {
    let current = st.current_revision();
    let needs_rebuild = match topo.as_ref() {
        Some(c) => c.revision < current,
        None => true,
    };
    if needs_rebuild {
        let prev = topo.take().map(|c| (c.rows, c.revision));
        let rows = build_rows(path).await.map_err(ApiError::Git)?;
        **topo = Some(TopoCache {
            revision: current,
            prev_rows: prev.as_ref().map(|(r, _)| r.clone()),
            prev_revision: prev.map(|(_, rev)| rev),
            rows,
        });
    }
    Ok(topo.as_ref().expect("topo cache just built"))
}
