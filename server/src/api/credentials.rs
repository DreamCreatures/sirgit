use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use crate::state::{AppState, RepoEvent};

/// Called by git's credential-helper (inline curl one-liner).
/// Blocks until the UI resolves the pending credentials request or timeout.
/// Prints the credential-helper protocol payload, or nothing on cancel/timeout.
#[derive(Deserialize)]
pub struct CredQuery {
    pub op: String,
    #[serde(default, rename = "remote")]
    pub _remote: String,
}

pub async fn get_credentials(
    State(app): State<Arc<AppState>>,
    Query(q): Query<CredQuery>,
) -> impl axum::response::IntoResponse {
    let Some(pending) = app.creds.get(&q.op) else {
        return axum::response::Response::builder()
            .status(200)
            .body(axum::body::Body::from(""))
            .unwrap();
    };

    // notify the repo room's WS subscribers so the credentials modal appears
    let path = match app.get_op(&q.op) {
        Some(op) => op.lock().await.path.clone(),
        None => String::new(),
    };
    if !path.is_empty() {
        if let Ok(st) = app.repo_state(&path) {
            st.send_event(RepoEvent::CredentialsRequest {
                op_id: q.op.clone(),
                remote: pending.remote.clone(),
            });
        }
    }

    let creds = app
        .creds
        .wait(&q.op, std::time::Duration::from_secs(130))
        .await;

    let body = match creds {
        Some((username, password)) => format!("username={}\npassword={}\n", username, password),
        None => String::new(),
    };
    app.creds.remove(&q.op);

    axum::response::Response::builder()
        .status(200)
        .header("content-type", "text/plain")
        .body(axum::body::Body::from(body))
        .unwrap()
}

#[derive(Deserialize)]
pub struct CredResponseParams {
    #[serde(rename = "opId")]
    pub op_id: String,
    pub username: String,
    pub password: String,
}

pub async fn post_response(State(app): State<Arc<AppState>>, Json(p): Json<CredResponseParams>) -> Json<serde_json::Value> {
    app.creds.resolve(&p.op_id, &p.username, &p.password);
    Json(serde_json::json!({}))
}

#[derive(Deserialize)]
pub struct CredCancelParams {
    #[serde(rename = "opId")]
    pub op_id: String,
}

pub async fn post_cancel(State(app): State<Arc<AppState>>, Json(p): Json<CredCancelParams>) -> Json<serde_json::Value> {
    app.creds.cancel(&p.op_id);
    Json(serde_json::json!({}))
}
