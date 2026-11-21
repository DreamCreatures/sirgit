//! Stash stack: list, per-stash file list (lazy), push, apply/pop, drop.
//! Stash commits live outside branch history, so these never touch the graph
//! topology — only the worktree, the index, and refs/stash.

use serde::Serialize;

use super::proc::{run_git, GitKind};
use super::repo::resolve_repo_paths;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: u32,
    pub sha: String,
    /// unix seconds of the stash commit
    pub date: i64,
    /// raw subject, e.g. "WIP on main: ab12345 fix the thing"
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashFile {
    pub path: String,
    /// name-status letter from `git stash show` (A/M/D/R)
    pub status: String,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
}

fn worktree_or_err(path: &str) -> Result<std::path::PathBuf, super::errors::GitError> {
    resolve_repo_paths(path)
        .map(|(w, _)| w)
        .map_err(|e| super::errors::GitError::new("not-a-repository", e, "resolve-repo", ""))
}

fn stash_ref(index: u32) -> String {
    format!("stash@{{{}}}", index)
}

/// Parse `git stash list --format=%gd%x1f%H%x1f%ct%x1f%s` (unit separator —
/// subjects freely contain colons, commas and pipes).
pub fn parse_stash_list(stdout: &str) -> Vec<StashEntry> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.splitn(4, '\u{1f}');
        let refname = parts.next().unwrap_or("");
        let sha = parts.next().unwrap_or("");
        let date = parts.next().unwrap_or("").parse().unwrap_or(0);
        let subject = parts.next().unwrap_or("").to_string();
        // refname is "stash@{N}"; fall back to list order if the format drifts
        let index = refname
            .strip_prefix("stash@{")
            .and_then(|r| r.strip_suffix('}'))
            .and_then(|n| n.parse().ok())
            .unwrap_or(out.len() as u32);
        out.push(StashEntry {
            index,
            sha: sha.to_string(),
            date,
            subject,
        });
    }
    out
}

/// The stash stack, newest first.
pub async fn list(repo: &str) -> Result<Vec<StashEntry>, super::errors::GitError> {
    let w = worktree_or_err(repo)?;
    let out = run_git(
        &w,
        &[
            "stash".into(),
            "list".into(),
            "--format=%gd%x1f%H%x1f%ct%x1f%s".into(),
        ],
        GitKind::ReadOnly,
    )
    .await?;
    Ok(parse_stash_list(&out.stdout))
}

/// Files changed in one stash with numstats. `--include-untracked` because a
/// stash made with -u keeps its untracked files on a third parent that the
/// plain diff would miss. Renames are keyed by their new path.
pub async fn files(repo: &str, index: u32) -> Result<Vec<StashFile>, super::errors::GitError> {
    let w = worktree_or_err(repo)?;
    let r = stash_ref(index);
    let ns = run_git(
        &w,
        &[
            "stash".into(),
            "show".into(),
            "--include-untracked".into(),
            "--name-status".into(),
            r.clone(),
        ],
        GitKind::ReadOnly,
    )
    .await?;
    let num = run_git(
        &w,
        &[
            "stash".into(),
            "show".into(),
            "--include-untracked".into(),
            "--numstat".into(),
            "-z".into(),
            r,
        ],
        GitKind::ReadOnly,
    )
    .await?;
    let nums = super::status::parse_numstat(&num.stdout);

    let mut out = Vec::new();
    for line in ns.stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut cols = line.splitn(3, '\t');
        // strip the rename score ("R100" → "R")
        let status = cols
            .next()
            .unwrap_or("M")
            .trim_end_matches(|c: char| c.is_ascii_digit())
            .to_string();
        let path = cols.next().unwrap_or("").to_string();
        if path.is_empty() {
            continue;
        }
        let n = nums.get(&path);
        out.push(StashFile {
            path,
            additions: n.and_then(|n| n.additions),
            deletions: n.and_then(|n| n.deletions),
            status,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Stash all changes — tracked plus untracked (matches "stash all" in the UI).
pub async fn push(repo: &str, message: Option<&str>) -> Result<(), super::errors::GitError> {
    let w = worktree_or_err(repo)?;
    let mut args = vec![
        "stash".into(),
        "push".into(),
        "--include-untracked".into(),
    ];
    if let Some(m) = message {
        args.push("--message".into());
        args.push(m.to_string());
    }
    run_git(&w, &args, GitKind::Mutation).await.map(|_| ())
}

/// Apply a stash into the worktree (everything lands unstaged). `pop` also
/// drops it; on conflict git keeps the stash, so nothing is lost either way.
pub async fn apply(repo: &str, index: u32, pop: bool) -> Result<(), super::errors::GitError> {
    let w = worktree_or_err(repo)?;
    let verb = if pop { "pop" } else { "apply" };
    run_git(
        &w,
        &["stash".into(), verb.into(), stash_ref(index)],
        GitKind::Mutation,
    )
    .await
    .map(|_| ())
}

pub async fn drop(repo: &str, index: u32) -> Result<(), super::errors::GitError> {
    let w = worktree_or_err(repo)?;
    run_git(
        &w,
        &["stash".into(), "drop".into(), stash_ref(index)],
        GitKind::Mutation,
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "sirgit-stash-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
                % 100000
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    fn git(dir: &std::path::Path, args: &[&str]) -> std::process::Output {
        std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap()
    }

    #[test]
    fn parses_stash_list_lines() {
        let out = "stash@{0}\u{1f}abc123\u{1f}1732200000\u{1f}WIP on main: 1234567 fix\n\
                   stash@{1}\u{1f}def456\u{1f}1732100000\u{1f}On feat: notes, pipes | and: colons\n";
        let list = parse_stash_list(out);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].index, 0);
        assert_eq!(list[0].sha, "abc123");
        assert_eq!(list[0].date, 1732200000);
        assert!(list[0].subject.starts_with("WIP on main"));
        assert_eq!(list[1].index, 1);
        assert!(list[1].subject.contains("pipes | and: colons"));
        assert!(parse_stash_list("").is_empty());
    }

    #[tokio::test]
    async fn push_list_files_apply_drop_roundtrip() {
        let tmp = tmp_dir("roundtrip");
        assert!(git(&tmp, &["init", "-q"]).status.success());
        std::fs::write(tmp.join("a.txt"), "one\n").unwrap();
        assert!(git(&tmp, &["add", "."]).status.success());
        assert!(git(&tmp, &["commit", "-q", "-m", "c1"]).status.success());

        // dirty a tracked file + create an untracked one, then stash all
        std::fs::write(tmp.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(tmp.join("u.txt"), "untracked\n").unwrap();
        push(tmp.to_str().unwrap(), None).await.unwrap();

        // worktree is clean again
        let st = super::super::status::read_status(tmp.to_str().unwrap()).await.unwrap();
        assert!(st.files.is_empty(), "stash should clean the worktree");

        let entries = list(tmp.to_str().unwrap()).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].subject.starts_with("WIP on "));

        // untracked-only content must be visible in the file list too (-u stash)
        let f = files(tmp.to_str().unwrap(), 0).await.unwrap();
        let a = f.iter().find(|x| x.path == "a.txt").unwrap();
        assert_eq!(a.status, "M");
        assert_eq!(a.additions, Some(1));
        let u = f.iter().find(|x| x.path == "u.txt").unwrap();
        assert_eq!(u.status, "A");

        // apply (no pop) restores the changes and keeps the stash
        apply(tmp.to_str().unwrap(), 0, false).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.join("a.txt")).unwrap(),
            "one\ntwo\n"
        );
        assert!(tmp.join("u.txt").exists());
        assert_eq!(list(tmp.to_str().unwrap()).await.unwrap().len(), 1);

        drop(tmp.to_str().unwrap(), 0).await.unwrap();
        assert!(list(tmp.to_str().unwrap()).await.unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
