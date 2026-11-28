
use serde::{Deserialize, Serialize};

use super::proc::{run_git, GitKind};
use super::repo::resolve_repo_paths;

/// One commit in the cached topology list. No numstat — diffs are fetched
/// per-commit on demand (ungit's biggest log-cost mistake).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_date: i64,
    pub commit_date: i64,
    pub subject: String,
}

/// Incremental change between two topology revisions.
#[derive(Debug, Clone, Serialize)]
pub struct TopoDelta {
    pub added: Vec<Row>,
    pub removed: Vec<String>,
}

pub const FIELD_SEP: char = '\x1f';
pub const RECORD_SEP: char = '\x1e';

const LOG_FORMAT: &str = "%H%x1f%P%x1f%an%x1f%at%x1f%ct%x1f%s%x1e";

/// Parse `git log --format=...` output (custom separators, defensive against
/// stray control chars).
pub fn parse_rows(stdout: &str) -> Vec<Row> {
    let mut rows = Vec::new();
    for record in stdout.split(RECORD_SEP) {
        let record = record.trim_start_matches('\n');
        if record.trim().is_empty() {
            continue;
        }
        let mut fields = record.split(FIELD_SEP);
        let (Some(sha), Some(parents), Some(author), Some(adate), Some(cdate), Some(subject)) =
            (fields.next(), fields.next(), fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let parents: Vec<String> = parents
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        rows.push(Row {
            sha: sha.trim().to_string(),
            parents,
            author: author.trim().to_string(),
            author_date: adate.trim().parse().unwrap_or(0),
            commit_date: cdate.trim().parse().unwrap_or(0),
            subject: subject.trim_end().to_string(),
        });
    }
    rows
}

/// How much topology is CACHED per revision. Beyond this, pages are fetched
/// on demand (git log --skip) — a full `--all` walk cost O(history) on EVERY
/// revision bump (checkout/commit/merge and even the watcher seeing the op's
/// own .git writes), which read as a 2-5s stale graph on real big projects.
/// 10k rows covers every loaded window a session realistically holds; deeper
/// history is old, stable, and walked only when someone actually scrolls
/// that far.
pub const TOPO_CAP: usize = 10_000;

/// Build the ordered topology for a repo (all refs, date-order), capped at
/// TOPO_CAP rows. Returns the rows plus whether history continues beyond the
/// cap. Errors classified as no-commits/empty (fresh repos) yield an empty list.
pub async fn build_rows(path: &str) -> Result<(Vec<Row>, bool), super::errors::GitError> {
    let (worktree, _gitdir) = resolve_repo_paths(path).map_err(|e| {
        super::errors::GitError::new("not-a-repository", e, "resolve-repo", "")
    })?;
    let args = vec![
        "log".into(),
        "--all".into(),
        "--date-order".into(),
        format!("--format={}", LOG_FORMAT),
        "--no-color".into(),
        // one row past the cap: its presence is the truncation signal
        format!("-n {}", TOPO_CAP + 1),
    ];
    match run_git(&worktree, &args, GitKind::ReadOnly).await {
        Ok(out) => {
            let mut rows = parse_rows(&out.stdout);
            let truncated = rows.len() > TOPO_CAP;
            rows.truncate(TOPO_CAP);
            Ok((rows, truncated))
        }
        Err(e) if e.code == "no-commits" || e.code == "bad-revision" || e.code == "not-a-repository" => Ok((Vec::new(), false)),
        Err(e) => Err(e),
    }
}

/// True total commit count across all refs. O(history) but a bare count (no
/// record pipe, no parse) — paid once per revision, lazily, only when a
/// client actually pages beyond the cached window.
pub async fn count_all(path: &str) -> Result<u64, super::errors::GitError> {
    let (worktree, _gitdir) = resolve_repo_paths(path).map_err(|e| {
        super::errors::GitError::new("not-a-repository", e, "resolve-repo", "")
    })?;
    let args = vec!["rev-list".into(), "--all".into(), "--count".into()];
    match run_git(&worktree, &args, GitKind::ReadOnly).await {
        Ok(out) => Ok(out.stdout.trim().parse().unwrap_or(0)),
        Err(e) if e.code == "no-commits" || e.code == "bad-revision" || e.code == "not-a-repository" => Ok(0),
        Err(e) => Err(e),
    }
}

/// One page from BEYOND the cached window: a direct paged walk. O(skip) per
/// request, but only paid when a user actually scrolls into old, stable
/// history (ungit paid it on every refresh).
pub async fn build_rows_paged(path: &str, offset: u64, limit: u64) -> Result<Vec<Row>, super::errors::GitError> {
    let (worktree, _gitdir) = resolve_repo_paths(path).map_err(|e| {
        super::errors::GitError::new("not-a-repository", e, "resolve-repo", "")
    })?;
    let args = vec![
        "log".into(),
        "--all".into(),
        "--date-order".into(),
        format!("--format={}", LOG_FORMAT),
        "--no-color".into(),
        format!("--skip={}", offset),
        format!("-n {}", limit),
    ];
    match run_git(&worktree, &args, GitKind::ReadOnly).await {
        Ok(out) => Ok(parse_rows(&out.stdout)),
        Err(e) if e.code == "no-commits" || e.code == "bad-revision" || e.code == "not-a-repository" => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// Diff two topology revisions: what the client needs to sync in O(delta).
pub fn compute_delta(prev: &[Row], cur: &[Row]) -> TopoDelta {
    use std::collections::HashSet;
    let prev_shas: HashSet<&str> = prev.iter().map(|r| r.sha.as_str()).collect();
    let cur_shas: HashSet<&str> = cur.iter().map(|r| r.sha.as_str()).collect();
    let added = cur.iter().filter(|r| !prev_shas.contains(r.sha.as_str())).cloned().collect();
    let removed = prev
        .iter()
        .filter(|r| !cur_shas.contains(r.sha.as_str()))
        .map(|r| r.sha.clone())
        .collect();
    TopoDelta { added, removed }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rows_with_newlines_in_subject() {
        let input = format!(
            "abc123\x1fdef456 ghi789\x1fAlice\x1f1700000000\x1f1700000005\x1fFirst commit{r}def456\x1f\x1fBob\x1f1700000100\x1f1700000100\x1fSecond{r}",
            r = RECORD_SEP
        );
        let rows = parse_rows(&input);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].sha, "abc123");
        assert_eq!(rows[0].parents, vec!["def456", "ghi789"]);
        assert_eq!(rows[0].author, "Alice");
        assert_eq!(rows[1].sha, "def456");
        assert!(rows[1].parents.is_empty());
    }

    #[test]
    fn delta_detects_add_and_remove() {
        let a = Row { sha: "a".into(), parents: vec![], author: "x".into(), author_date: 1, commit_date: 1, subject: "a".into() };
        let b = Row { sha: "b".into(), parents: vec!["a".into()], author: "x".into(), author_date: 2, commit_date: 2, subject: "b".into() };
        let c = Row { sha: "c".into(), parents: vec!["b".into()], author: "x".into(), author_date: 3, commit_date: 3, subject: "c".into() };

        let d = compute_delta(&[a.clone(), b.clone()], &[c.clone(), b.clone(), a.clone()]);
        assert_eq!(d.added, vec![c]);
        assert!(d.removed.is_empty());

        let d = compute_delta(&[a.clone(), b.clone()], &[a.clone()]);
        assert!(d.added.is_empty());
        assert_eq!(d.removed, vec!["b".to_string()]);
    }

    /// End-to-end: a real fixture repo parsed through build_rows.
    #[tokio::test]
    async fn builds_rows_from_real_repo() {
        let tmp = std::env::temp_dir().join(format!("sirgit-logtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let git = |args: &[&str], cwd: &std::path::Path| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .env("GIT_AUTHOR_DATE", "2024-01-01T00:00:00Z")
                .env("GIT_COMMITTER_DATE", "2024-01-01T00:00:00Z")
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"], &tmp).status.success());
        assert!(git(&["config", "user.name", "T"], &tmp).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"], &tmp).status.success());
        std::fs::write(tmp.join("f.txt"), "one\n").unwrap();
        assert!(git(&["add", "."], &tmp).status.success());
        assert!(git(&["commit", "-q", "-m", "first"], &tmp).status.success());
        assert!(git(&["branch", "feature"], &tmp).status.success());

        let (rows, truncated) = build_rows(tmp.to_str().unwrap()).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subject, "first");
        assert!(rows[0].parents.is_empty());
        assert!(!truncated, "a one-commit repo is not truncated");

        // empty repo → no error, no rows
        let tmp2 = std::env::temp_dir().join(format!("sirgit-logtest2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp2);
        std::fs::create_dir_all(&tmp2).unwrap();
        assert!(git(&["init", "-q", "-b", "main"], &tmp2).status.success());
        assert!(git(&["config", "user.name", "T"], &tmp2).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"], &tmp2).status.success());
        let (rows2, truncated2) = build_rows(tmp2.to_str().unwrap()).await.unwrap();
        assert!(rows2.is_empty());
        assert!(!truncated2);

        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(&tmp2);
    }
}
