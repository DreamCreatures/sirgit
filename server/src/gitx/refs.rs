use std::path::Path;

use serde::{Deserialize, Serialize};

use super::proc::{run_git, GitKind};
use super::repo::resolve_repo_paths;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    /// Short name, e.g. "main", "origin/main", "v1.0"
    pub name: String,
    pub sha: String,
    #[serde(rename = "type")]
    pub kind: RefKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RefKind {
    Branch,
    RemoteBranch,
    Tag,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    pub sha: Option<String>,
    /// Short branch name when on a branch; None when detached
    pub branch: Option<String>,
    pub detached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsSnapshot {
    pub branches: Vec<RefInfo>,
    pub remote_branches: Vec<RefInfo>,
    pub tags: Vec<RefInfo>,
    pub remotes: Vec<String>,
    pub head: Head,
    /// tag names that exist on the remote (ls-remote cache, refreshed after
    /// every fetch/push/pull) — drives the UI's pushed-tag chips
    pub remote_tags: Vec<String>,
    /// the remote those tags were last fetched from — the pushed-tag prefix
    /// names the actual remote (origin is a name, not a keyword)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_tags_remote: Option<String>,
    /// Short upstream name of the current branch (e.g. "origin/main"), if any
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
}

// %(*objectname) is the PEELED sha — the commit an annotated tag points at.
// Plain %(objectname) reports the tag object itself, whose sha matches no
// graph row, so annotated-tag chips never landed on any commit.
const REF_FORMAT: &str = "%(objectname)%1f%(refname)%1f%(upstream:short)%1f%(*objectname)%1e";

/// Full ref snapshot: local branches, remote branches, tags, remotes, HEAD.
pub async fn read_refs(path: &str) -> Result<RefsSnapshot, super::errors::GitError> {
    let (worktree, gitdir) = resolve_repo_paths(path).map_err(|e| {
        super::errors::GitError::new("not-a-repository", e, "resolve-repo", "")
    })?;

    let args = vec![
        "for-each-ref".into(),
        "--format=".to_string() + REF_FORMAT,
        "refs/heads".into(),
        "refs/remotes".into(),
        "refs/tags".into(),
    ];
    let out = run_git(&worktree, &args, GitKind::ReadOnly).await?;

    let mut branches = Vec::new();
    let mut remote_branches = Vec::new();
    let mut tags = Vec::new();
    for record in out.stdout.split('\x1e') {
        let record = record.trim_start_matches('\n');
        if record.trim().is_empty() {
            continue;
        }
        let mut f = record.split('\x1f');
        let (Some(sha), Some(refname), upstream, peeled) = (f.next(), f.next(), f.next(), f.next()) else { continue };
        let sha = sha.trim().to_string();
        let refname = refname.trim();
        let upstream = upstream.unwrap_or("").trim();
        let upstream = if upstream.is_empty() { None } else { Some(upstream.to_string()) };
        let peeled = peeled.unwrap_or("").trim();
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            branches.push(RefInfo { name: name.to_string(), sha, kind: RefKind::Branch, upstream });
        } else if let Some(name) = refname.strip_prefix("refs/tags/") {
            // annotated tag → use the commit it dereferences to
            let sha = if peeled.is_empty() { sha } else { peeled.to_string() };
            tags.push(RefInfo { name: name.to_string(), sha, kind: RefKind::Tag, upstream: None });
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            // skip the "origin/HEAD -> origin/main" style entries (no sha match issue; they carry "^{}" in newer git? they appear as remote branch named origin/HEAD)
            if name.ends_with("/HEAD") {
                continue;
            }
            remote_branches.push(RefInfo { name: name.to_string(), sha, kind: RefKind::RemoteBranch, upstream: None });
        }
    }

    let remotes = read_remotes(&worktree).await?;
    let head = read_head(&worktree).await?;

    // ahead/behind vs upstream for the current branch (single extra spawn)
    let (mut upstream, mut ahead, mut behind) = (None, 0, 0);
    if let Some(branch) = head.branch.as_deref() {
        if let Ok(cfg) = run_git(
            &worktree,
            &["config".to_string(), "--get".to_string(), format!("branch.{}.merge", branch)],
            GitKind::ReadOnly,
        )
        .await
        {
            let merge_ref = cfg.stdout.trim().trim_start_matches("refs/heads/").to_string();
            if !merge_ref.is_empty() {
                if let Ok(remote_out) = run_git(
                    &worktree,
                    &["config".to_string(), "--get".to_string(), format!("branch.{}.remote", branch)],
                    GitKind::ReadOnly,
                )
                .await
                {
                    let remote = remote_out.stdout.trim().to_string();
                    if !remote.is_empty() && remote != "." {
                        let short = format!("{}/{}", remote, merge_ref);
                        upstream = Some(short.clone());
                        if let Ok(ab) = run_git(
                            &worktree,
                            &[
                                "rev-list".to_string(),
                                "--left-right".to_string(),
                                "--count".to_string(),
                                format!("{}...{}", short, branch),
                            ],
                            GitKind::ReadOnly,
                        )
                        .await
                        {
                            let mut it = ab.stdout.trim().split_whitespace();
                            behind = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                            ahead = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                        }
                    }
                }
            }
        }
    }

    let tag_cache = super::remote_tags::read_cached(&gitdir);

    Ok(RefsSnapshot { branches, remote_branches, tags, remotes, head, remote_tags: tag_cache.tags, remote_tags_remote: tag_cache.remote, upstream, ahead, behind })
}

pub async fn read_remotes(worktree: &Path) -> Result<Vec<String>, super::errors::GitError> {
    let out = run_git(worktree, &["remote".to_string()], GitKind::ReadOnly).await?;
    Ok(out.stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

/// HEAD resolution: branch name (symbolic) or detached sha.
pub async fn read_head(worktree: &Path) -> Result<Head, super::errors::GitError> {
    let sym = run_git(
        worktree,
        &["symbolic-ref".into(), "-q".into(), "--short".into(), "HEAD".into()],
        GitKind::ReadOnly,
    )
    .await;
    match sym {
        Ok(out) => {
            let branch = out.stdout.trim().to_string();
            let sha = rev_parse_head(worktree)
                .await
                .ok_or_else(|| super::errors::GitError::new("no-head", "HEAD cannot be resolved", "git rev-parse HEAD", ""))?;
            Ok(Head { sha: Some(sha), branch: Some(branch), detached: false })
        }
        Err(_) => {
            // detached or unborn
            match rev_parse_head(worktree).await {
                Some(sha) => Ok(Head { sha: Some(sha), branch: None, detached: true }),
                None => Ok(Head { sha: None, branch: None, detached: false }),
            }
        }
    }
}

async fn rev_parse_head(worktree: &Path) -> Option<String> {
    let out = run_git(worktree, &["rev-parse".into(), "HEAD".into()], GitKind::ReadOnly).await.ok()?;
    let s = out.stdout.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (temp_dir_guard::TempDir, ) {
        let td = temp_dir_guard::TempDir::new("sirgit-refstest");
        let p = td.path.clone();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&p)
                .env("GIT_AUTHOR_NAME", "T").env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T").env("GIT_COMMITTER_EMAIL", "t@t")
                .output().unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        assert!(git(&["config", "user.name", "T"]).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"]).status.success());
        std::fs::write(p.join("f.txt"), "x\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c1"]).status.success());
        assert!(git(&["branch", "feature"]).status.success());
        assert!(git(&["tag", "v1.0"]).status.success());
        (td,)
    }

    mod temp_dir_guard {
        pub struct TempDir {
            pub path: std::path::PathBuf,
        }
        impl TempDir {
            pub fn new(tag: &str) -> Self {
                let path = std::env::temp_dir().join(format!("{}-{}-{}", tag, std::process::id(), rand_suffix()));
                std::fs::create_dir_all(&path).unwrap();
                Self { path }
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }
        fn rand_suffix() -> u128 {
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() % 1_000_000
        }
    }

    #[tokio::test]
    async fn reads_refs_of_fixture() {
        let (td,) = fixture();
        let snap = read_refs(td.path.to_str().unwrap()).await.unwrap();
        let names: Vec<&str> = snap.branches.iter().map(|b| b.name.as_str()).collect();
        assert!(names.contains(&"main") || names.contains(&"master"));
        assert!(names.contains(&"feature"));
        assert_eq!(snap.tags.len(), 1);
        assert_eq!(snap.tags[0].name, "v1.0");
        assert!(snap.remotes.is_empty());
        assert_eq!(snap.head.branch.as_deref(), Some("main"));
        assert!(!snap.head.detached);
    }

    #[tokio::test]
    async fn annotated_tags_peel_to_their_commit() {
        let (td,) = fixture();
        // v2.0 is ANNOTATED: refs/tags/v2.0 points at a tag OBJECT whose sha
        // matches no graph row — read_refs must report the peeled commit
        let p = &td.path;
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(p)
                .env("GIT_AUTHOR_NAME", "T").env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T").env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
        };
        assert!(git(&["tag", "-a", "v2.0", "-m", "release"]).status.success());
        let head = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout).trim().to_string();
        let snap = read_refs(td.path.to_str().unwrap()).await.unwrap();
        let v2 = snap.tags.iter().find(|t| t.name == "v2.0").expect("annotated tag listed");
        assert_eq!(v2.sha, head, "annotated tag must peel to the commit sha");
    }
}
