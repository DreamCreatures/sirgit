use std::future::Future;
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::error::{ApiError, ApiResult};
use crate::gitx::errors::GitError;
use crate::gitx::ops;
use crate::state::{AppState, RepoEvent, RepoState};

// ---------- shared helpers ----------

pub async fn locked(app: &Arc<AppState>, path: &str) -> ApiResult<(Arc<RepoState>, tokio::sync::OwnedMutexGuard<()>)> {
    let st = app.repo_state(path).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let guard = st.write_lock.clone().lock_owned().await;
    Ok((st, guard))
}

pub fn ok_json() -> Json<serde_json::Value> {
    Json(json!({}))
}

/// Spawn a long-running network op with credentials + progress wired up.
/// Returns the op id for the client to poll / receive WS progress.
fn start_network_op<F, Fut>(
    app: &Arc<AppState>,
    st: &Arc<RepoState>,
    op: &'static str,
    path: &str,
    remote: &str,
    f: F,
) -> String
where
    F: FnOnce(Vec<String>, String) -> Fut + Send + 'static,
    Fut: Future<Output = Result<(), GitError>> + Send + 'static,
{
    let (op_id, op_state) = app.start_op(op, path);
    let remote_owned = remote.to_string();
    app.creds.register(&op_id, &remote_owned);
    let cred_args = ops::credential_args(app.config.port, &op_id, &ops::b64_url(remote.as_bytes()));

    let app2 = app.clone();
    let st2 = st.clone();
    let op_id2 = op_id.clone();
    let op_state2 = op_state.clone();
    let op_name = op.to_string();
    tokio::spawn(async move {
        let result = f(cred_args, remote_owned).await;
        {
            let mut s = op_state2.lock().await;
            match &result {
                Ok(()) => {
                    s.status = "done".into();
                    s.progress.push(format!("{} complete", op_name));
                }
                Err(e) => {
                    s.status = "error".into();
                    s.error = Some(serde_json::to_value(e).unwrap_or_default());
                }
            }
        }
        st2.send_event(RepoEvent::OpProgress {
            op_id: op_id2.clone(),
            op: op_name,
            text: if result.is_ok() { "done".into() } else { "failed".into() },
            done: Some(true),
        });
        st2.bump(&["refs"]);
        app2.creds.remove(&op_id2);
    });
    op_id
}

// ---------- request payloads ----------

#[derive(Deserialize)]
pub struct FilesParams {
    pub path: String,
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Deserialize)]
pub struct DiscardParams {
    pub path: String,
    #[serde(default)]
    pub files: Vec<String>,
    /// untracked subset of `files` (deleted from disk instead of git-restored)
    #[serde(default)]
    pub untracked: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")] // client sends allowEmpty
pub struct CommitParams {
    pub path: String,
    pub message: String,
    #[serde(default)]
    pub amend: bool,
    #[serde(default)]
    pub allow_empty: bool,
}

#[derive(Deserialize)]
pub struct CheckoutParams {
    pub path: String,
    #[serde(rename = "ref")]
    pub ref_name: String,
    #[serde(default)]
    pub remote: Option<String>,
}

#[derive(Deserialize)]
pub struct BranchCreateParams {
    pub path: String,
    pub name: String,
    pub sha: String,
    #[serde(default)]
    pub checkout: bool,
}

#[derive(Deserialize)]
pub struct BranchDeleteParams {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub force: bool,
}

#[derive(Deserialize)]
pub struct OrphanParams {
    pub path: String,
    #[serde(default)]
    pub message: String,
}

#[derive(Deserialize)]
pub struct TagCreateParams {
    pub path: String,
    pub name: String,
    pub sha: String,
}

#[derive(Deserialize)]
pub struct NameParams {
    pub path: String,
    pub name: String,
}

#[derive(Deserialize)]
pub struct MergeContinueParams {
    pub path: String,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Deserialize)]
pub struct PathOnlyParams {
    pub path: String,
}

#[derive(Deserialize)]
pub struct RenameParams {
    pub path: String,
    #[serde(rename = "oldName")]
    pub old_name: String,
    #[serde(rename = "newName")]
    pub new_name: String,
}

#[derive(Deserialize)]
pub struct SquashParams {
    pub path: String,
    pub branch: String,
    pub target: String,
}

#[derive(Deserialize)]
pub struct MoveBranchParams {
    pub path: String,
    pub branch: String,
    pub target: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeBranchParams {
    pub path: String,
    pub from: String,
    pub into: String,
    #[serde(default)]
    pub squash: bool,
}

#[derive(Deserialize)]
pub struct PullParams {
    pub path: String,
    /// Branch to pull into (defaults to the current branch)
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Deserialize)]
pub struct FetchParams {
    pub path: String,
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default = "default_true")]
    pub prune: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
pub struct PushParams {
    pub path: String,
    pub remote: String,
    pub refspec: String,
    #[serde(default)]
    pub force: bool,
}

// ---------- simple (write-locked, inline) ops ----------

pub async fn stage(State(app): State<Arc<AppState>>, Json(p): Json<FilesParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::stage(&p.path, &p.files).await.map_err(ApiError::Git)?;
    _st.bump(&["index", "worktree"]);
    Ok(ok_json())
}

pub async fn unstage(State(app): State<Arc<AppState>>, Json(p): Json<FilesParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::unstage(&p.path, &p.files).await.map_err(ApiError::Git)?;
    _st.bump(&["index", "worktree"]);
    Ok(ok_json())
}

pub async fn discard(State(app): State<Arc<AppState>>, Json(p): Json<DiscardParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::discard(&p.path, &p.files, &p.untracked).await.map_err(ApiError::Git)?;
    _st.bump(&["index", "worktree"]);
    Ok(ok_json())
}

pub async fn commit(State(app): State<Arc<AppState>>, Json(p): Json<CommitParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::commit(&p.path, &p.message, p.amend, p.allow_empty)
        .await
        .map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

pub async fn checkout(State(app): State<Arc<AppState>>, Json(p): Json<CheckoutParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::checkout(&p.path, &p.ref_name, p.remote.as_deref())
        .await
        .map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

pub async fn branch_create(State(app): State<Arc<AppState>>, Json(p): Json<BranchCreateParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::create_branch(&p.path, &p.name, &p.sha, p.checkout)
        .await
        .map_err(ApiError::Git)?;
    _st.bump(&["refs"]);
    Ok(ok_json())
}

pub async fn branch_delete(State(app): State<Arc<AppState>>, Json(p): Json<BranchDeleteParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::delete_branch(&p.path, &p.name, p.force).await.map_err(ApiError::Git)?;
    _st.bump(&["refs"]);
    Ok(ok_json())
}

/// Create an orphan commit (no parents, no branch). Returns its sha; the
/// graph picks it up through the normal refs-delta (pinned via
/// refs/sirgit/orphans/, so `git log --all` includes it).
pub async fn orphan_create(State(app): State<Arc<AppState>>, Json(p): Json<OrphanParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    let message = if p.message.trim().is_empty() { "Orphan commit".to_string() } else { p.message.clone() };
    let sha = ops::create_orphan(&p.path, &message).await.map_err(ApiError::Git)?;
    _st.bump(&["refs"]);
    Ok(Json(serde_json::json!({ "sha": sha })))
}

pub async fn tag_create(State(app): State<Arc<AppState>>, Json(p): Json<TagCreateParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::create_tag(&p.path, &p.name, &p.sha).await.map_err(ApiError::Git)?;
    _st.bump(&["refs"]);
    Ok(ok_json())
}

pub async fn tag_delete(State(app): State<Arc<AppState>>, Json(p): Json<NameParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::delete_tag(&p.path, &p.name).await.map_err(ApiError::Git)?;
    _st.bump(&["refs"]);
    Ok(ok_json())
}

pub async fn uncommit(State(app): State<Arc<AppState>>, Json(p): Json<PathOnlyParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::uncommit(&p.path).await.map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

pub async fn branch_rename(State(app): State<Arc<AppState>>, Json(p): Json<RenameParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::rename_branch(&p.path, &p.old_name, &p.new_name).await.map_err(ApiError::Git)?;
    _st.bump(&["refs"]);
    Ok(ok_json())
}

pub async fn tag_rename(State(app): State<Arc<AppState>>, Json(p): Json<RenameParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::rename_tag(&p.path, &p.old_name, &p.new_name).await.map_err(ApiError::Git)?;
    _st.bump(&["refs"]);
    Ok(ok_json())
}

pub async fn squash(State(app): State<Arc<AppState>>, Json(p): Json<SquashParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    let message = ops::squash(&p.path, &p.branch, &p.target).await.map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    match message {
        // soft path: gathered (title, body) for the UI's commit-box prefill
        Some((title, body)) => Ok(Json(serde_json::json!({ "title": title, "body": body }))),
        None => Ok(ok_json()),
    }
}

pub async fn move_branch(State(app): State<Arc<AppState>>, Json(p): Json<MoveBranchParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::move_branch(&p.path, &p.branch, &p.target).await.map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

pub async fn merge_branch(State(app): State<Arc<AppState>>, Json(p): Json<MergeBranchParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    let message = ops::merge_branch(&p.path, &p.from, &p.into, p.squash).await.map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    match message {
        // squash: gathered (title, body) for the UI's commit-box prefill
        Some((title, body)) => Ok(Json(serde_json::json!({ "title": title, "body": body }))),
        None => Ok(ok_json()),
    }
}

pub async fn resolve(State(app): State<Arc<AppState>>, Json(p): Json<FilesParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::resolve_conflicts(&p.path, &p.files).await.map_err(ApiError::Git)?;
    _st.bump(&["index", "worktree"]);
    Ok(ok_json())
}

pub async fn merge_continue(State(app): State<Arc<AppState>>, Json(p): Json<MergeContinueParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::merge_continue(&p.path, p.message.as_deref()).await.map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

pub async fn merge_abort(State(app): State<Arc<AppState>>, Json(p): Json<PathOnlyParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::merge_abort(&p.path).await.map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

pub async fn rebase_continue(State(app): State<Arc<AppState>>, Json(p): Json<PathOnlyParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::rebase_continue(&p.path).await.map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

pub async fn rebase_abort(State(app): State<Arc<AppState>>, Json(p): Json<PathOnlyParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::rebase_abort(&p.path).await.map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStartParams {
    pub path: String,
    /// branch name or sha to rebase the current branch onto
    pub onto: String,
}

pub async fn rebase_start(State(app): State<Arc<AppState>>, Json(p): Json<RebaseStartParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::rebase_start(&p.path, &p.onto).await.map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertParams {
    pub path: String,
    pub sha: String,
}

pub async fn revert(State(app): State<Arc<AppState>>, Json(p): Json<RevertParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::revert_commit(&p.path, &p.sha).await.map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

pub async fn revert_continue(State(app): State<Arc<AppState>>, Json(p): Json<PathOnlyParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::revert_continue(&p.path).await.map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

pub async fn revert_abort(State(app): State<Arc<AppState>>, Json(p): Json<PathOnlyParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::revert_abort(&p.path).await.map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

pub async fn cherry_pick(State(app): State<Arc<AppState>>, Json(p): Json<RevertParams>) -> ApiResult<Json<serde_json::Value>> {
    let (_st, _g) = locked(&app, &p.path).await?;
    ops::cherry_pick(&p.path, &p.sha).await.map_err(ApiError::Git)?;
    _st.bump(&["refs", "index", "worktree"]);
    Ok(ok_json())
}

// ---------- network ops (async, with opId + credentials + progress) ----------

pub async fn fetch(State(app): State<Arc<AppState>>, Json(p): Json<FetchParams>) -> ApiResult<Json<serde_json::Value>> {
    let st = app.repo_state(&p.path).map_err(|e| ApiError::BadRequest(e.to_string()))?;

    // resolve target remote(s)
    let snapshot = crate::gitx::refs::read_refs(&p.path).await.map_err(ApiError::Git)?;
    let remotes: Vec<String> = match p.remote {
        Some(r) => vec![r],
        None => snapshot.remotes.clone(),
    };
    if remotes.is_empty() {
        return Err(ApiError::BadRequest("no remotes configured".into()));
    }

    let prune = p.prune;
    let path = p.path.clone();
    let first_remote = remotes[0].clone();
    let op_id = start_network_op(&app, &st, "fetch", &path.clone(), &first_remote, move |cred_args, _remote| async move {
        let mut last_err: Option<GitError> = None;
        for r in remotes {
            if let Err(e) = ops::fetch(&path, &r, prune, &cred_args).await {
                if e.code == "offline" || e.code == "authentication-failed" {
                    return Err(e);
                }
                last_err = Some(e);
            }
        }
        match last_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    });
    Ok(Json(json!({ "opId": op_id })))
}

pub async fn push(State(app): State<Arc<AppState>>, Json(p): Json<PushParams>) -> ApiResult<Json<serde_json::Value>> {
    let st = app.repo_state(&p.path).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let path = p.path.clone();
    let refspec = p.refspec.clone();
    let force = p.force;
    let remote = p.remote.clone();
    let op_id = start_network_op(&app, &st, "push", &path.clone(), &remote, move |cred_args, remote| async move {
        ops::push(&path, &remote, &refspec, force, &cred_args).await
    });
    Ok(Json(json!({ "opId": op_id })))
}

pub async fn pull(State(app): State<Arc<AppState>>, Json(p): Json<PullParams>) -> ApiResult<Json<serde_json::Value>> {
    let st = app.repo_state(&p.path).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let path = p.path.clone();
    let branch = p.branch.clone();
    let op_id = start_network_op(&app, &st, "pull", &path.clone(), "origin", move |cred_args, _remote| async move {
        ops::pull(&path, branch.as_deref(), &cred_args).await
    });
    Ok(Json(json!({ "opId": op_id })))
}
