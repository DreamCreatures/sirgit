use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::gitx::errors::GitError;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFound(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message, extra) = match &self {
            ApiError::Git(g) => (StatusCode::INTERNAL_SERVER_ERROR, g.code.clone(), g.message.clone(), json!({ "command": g.command, "stderr": g.stderr })),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, "bad-request".into(), m.clone(), json!({})),
            ApiError::NotFound(m) => (StatusCode::NOT_FOUND, "not-found".into(), m.clone(), json!({})),
            ApiError::Io(e) => (StatusCode::INTERNAL_SERVER_ERROR, "io-error".into(), e.to_string(), json!({})),
        };
        let mut body = json!({ "error": { "code": code, "message": message } });
        if let Some(obj) = body.as_object_mut() {
            for (k, v) in extra.as_object().unwrap() {
                obj.insert(k.clone(), v.clone());
            }
        }
        (status, axum::Json(body)).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
