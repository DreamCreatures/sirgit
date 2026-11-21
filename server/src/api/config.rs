use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::config::SirgitConfig;
use crate::error::ApiResult;
use crate::state::AppState;

pub async fn get_config(State(app): State<Arc<AppState>>) -> ApiResult<Json<SirgitConfig>> {
    Ok(Json(app.config.public()))
}

#[derive(Deserialize)]
pub struct UpdateConfig {
    #[serde(default)]
    pub auto_fetch_on_open: Option<bool>,
    #[serde(default)]
    pub page_size: Option<u32>,
    #[serde(default)]
    pub theme: Option<String>,
}

pub async fn put_config(
    State(app): State<Arc<AppState>>,
    Json(p): Json<UpdateConfig>,
) -> ApiResult<Json<SirgitConfig>> {
    let mut cfg = app.config.clone();
    if let Some(v) = p.auto_fetch_on_open {
        cfg.auto_fetch_on_open = v;
    }
    if let Some(v) = p.page_size {
        cfg.page_size = v.clamp(10, 2000);
    }
    if let Some(v) = p.theme {
        cfg.theme = v;
    }
    cfg.save().map_err(|e| crate::error::ApiError::BadRequest(e.to_string()))?;
    Ok(Json(cfg))
}
