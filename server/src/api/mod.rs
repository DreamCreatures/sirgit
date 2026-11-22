pub mod commit;
pub mod config;
pub mod credentials;
pub mod log;
pub mod ops;
pub mod refs;
pub mod repo;
pub mod stash;
pub mod status;
pub mod ws;

use std::sync::Arc;

use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{extract::State, Router};
use serde::Serialize;

use crate::error::ApiResult;
use crate::state::AppState;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/version", get(version))
        .route("/api/config", get(config::get_config).put(config::put_config))
        .route("/api/quickstatus", get(repo::quickstatus))
        .route("/api/init", post(repo::init))
        .route("/api/createdir", post(repo::createdir))
        .route("/api/clone", post(repo::clone))
        .route("/api/ops/{opId}", get(repo::op_status))
        .route("/api/log", get(log::log_page))
        .route("/api/log/delta", get(log::log_delta))
        .route("/api/refs", get(refs::refs))
        .route("/api/status", get(status::status))
        .route("/api/commit/{sha}", get(commit::detail))
        .route("/api/commit/{sha}/diff", get(commit::file_diff))
        .route("/api/diff", get(commit::worktree_diff))
        .route("/api/stage", post(ops::stage))
        .route("/api/unstage", post(ops::unstage))
        .route("/api/discard", post(ops::discard))
        .route("/api/commit", post(ops::commit))
        .route("/api/checkout", post(ops::checkout))
        .route("/api/branch/create", post(ops::branch_create))
        .route("/api/branch/delete", post(ops::branch_delete))
        .route("/api/orphan/create", post(ops::orphan_create))
        .route("/api/branch/rename", post(ops::branch_rename))
        .route("/api/tag/rename", post(ops::tag_rename))
        .route("/api/uncommit", post(ops::uncommit))
        .route("/api/squash", post(ops::squash))
        .route("/api/revert", post(ops::revert))
        .route("/api/revert/continue", post(ops::revert_continue))
        .route("/api/revert/abort", post(ops::revert_abort))
        .route("/api/cherry-pick", post(ops::cherry_pick))
        .route("/api/branch/move", post(ops::move_branch))
        .route("/api/branch/fast-forward", post(ops::branch_fast_forward))
        .route("/api/tag/move", post(ops::move_tag))
        .route("/api/branch/merge", post(ops::merge_branch))
        .route("/api/tag/create", post(ops::tag_create))
        .route("/api/tag/delete", post(ops::tag_delete))
        .route("/api/resolve", post(ops::resolve))
        .route("/api/merge/continue", post(ops::merge_continue))
        .route("/api/merge/abort", post(ops::merge_abort))
        .route("/api/rebase/continue", post(ops::rebase_continue))
        .route("/api/rebase/abort", post(ops::rebase_abort))
        .route("/api/rebase/start", post(ops::rebase_start))
        .route("/api/stash", get(stash::list))
        .route("/api/stash/files", get(stash::files))
        .route("/api/stash/push", post(stash::push))
        .route("/api/stash/apply", post(stash::apply))
        .route("/api/stash/drop", post(stash::drop))
        .route("/api/fetch", post(ops::fetch))
        .route("/api/push", post(ops::push))
        .route("/api/pull", post(ops::pull))
        .route("/api/credentials", get(credentials::get_credentials))
        .route("/api/credentials-response", post(credentials::post_response))
        .route("/api/credentials-cancel", post(credentials::post_cancel))
        .route("/ws", get(ws::ws_handler))
        .fallback(static_assets)
        .with_state(state)
}

#[derive(Serialize)]
pub struct VersionInfo {
    pub version: String,
    pub git_version: String,
}

async fn version(State(_app): State<Arc<AppState>>) -> ApiResult<impl IntoResponse> {
    let out = tokio::process::Command::new("git")
        .arg("--version")
        .output()
        .await
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    Ok(axum::Json(VersionInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        git_version: out,
    }))
}

async fn static_assets(uri: axum::extract::OriginalUri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match WebAssets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            let mut headers = axum::http::HeaderMap::new();
            headers.insert(axum::http::header::CONTENT_TYPE, mime.as_ref().parse().unwrap());
            // hashed assets are immutable; index.html must always revalidate
            if path.ends_with(".html") {
                headers.insert(axum::http::header::CACHE_CONTROL, "no-cache".parse().unwrap());
            } else {
                headers.insert(axum::http::header::CACHE_CONTROL, "public, max-age=31536000, immutable".parse().unwrap());
            }
            (headers, content.data.to_vec()).into_response()
        }
        None => {
            // SPA fallback
            match WebAssets::get("index.html") {
                Some(content) => (
                    [
                        (axum::http::header::CONTENT_TYPE, "text/html".to_string()),
                        (axum::http::header::CACHE_CONTROL, "no-cache".to_string()),
                    ],
                    content.data.to_vec(),
                )
                    .into_response(),
                None => (
                    axum::http::StatusCode::NOT_FOUND,
                    "sirgit frontend is not built. Run `pnpm build` in web/ (dev: use `pnpm dev` with the Vite proxy).",
                )
                    .into_response(),
            }
        }
    }
}

#[derive(rust_embed::RustEmbed)]
#[folder = "../web/dist"]
struct WebAssets;
