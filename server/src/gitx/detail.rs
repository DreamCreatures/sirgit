
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::proc::{run_git, run_git_diff_no_index, GitKind};
use super::repo::resolve_repo_paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    /// 'A' | 'M' | 'D' | 'R' | 'C' | 'T'
    pub status: String,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_date: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub commit_date: i64,
    pub subject: String,
    pub body: String,
    pub files: Vec<CommitFile>,
    pub additions: i64,
    pub deletions: i64,
}

const META_FORMAT: &str =
    "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%s%x1f%b%x1e";

/// Parse `git diff-tree --root -r --name-status -z --no-commit-id <sha>`.
/// Returns (path, status, origPath-for-renames).
fn parse_name_status(stdout: &str) -> Vec<(String, String, Option<String>)> {
    let mut out = Vec::new();
    let tokens: Vec<&str> = stdout.split('\0').collect();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        if tok.trim().is_empty() {
            i += 1;
            continue;
        }
        let status = tok.chars().next().unwrap_or('M').to_string();
        if status == "R" || status == "C" {
            // tokens: <R100>, <orig>, <new>
            let orig = tokens.get(i + 1).copied().unwrap_or("").to_string();
            let new_path = tokens.get(i + 2).copied().unwrap_or("").to_string();
            out.push((new_path, status, Some(orig)));
            i += 3;
        } else {
            let path = tokens.get(i + 1).copied().unwrap_or("").to_string();
            out.push((path, status, None));
            i += 2;
        }
    }
    out
}

fn parse_numstat_raw(stdout: &str) -> std::collections::HashMap<String, (Option<i64>, Option<i64>, bool)> {
    let mut map = std::collections::HashMap::new();
    let tokens: Vec<&str> = stdout.split('\0').collect();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        if tok.trim().is_empty() {
            i += 1;
            continue;
        }
        let mut parts = tok.splitn(3, '\t');
        let add = parts.next().unwrap_or("").trim().to_string();
        let del = parts.next().unwrap_or("").trim().to_string();
        let path = parts.next().unwrap_or("").to_string();
        // renames: origPath follows in the next token (no tabs)
        let next_is_orig = tokens.get(i + 1).map(|t| !t.contains('\t') && !t.is_empty()).unwrap_or(false);
        let entry = (
            if add == "-" { None } else { add.parse().ok() },
            if del == "-" { None } else { del.parse().ok() },
            add == "-",
        );
        if !path.is_empty() {
            map.insert(path, entry);
        }
        i += if next_is_orig { 2 } else { 1 };
    }
    map
}

/// Full commit detail: metadata + per-file stats. For merges, diffs vs first parent.
pub async fn commit_detail(path: &str, sha: &str) -> Result<CommitDetail, super::errors::GitError> {
    let (worktree, _) = resolve_repo_paths(path).map_err(|e| {
        super::errors::GitError::new("not-a-repository", e, "resolve-repo", "")
    })?;

    let meta_args = vec![
        "show".into(),
        "-s".into(),
        format!("--format={}", META_FORMAT),
        "--no-show-signature".into(),
        sha.to_string(),
    ];
    let meta = run_git(&worktree, &meta_args, GitKind::ReadOnly).await?;
    let record = meta.stdout.split('\x1e').next().unwrap_or("");
    let mut f = record.split('\x1f');
    let sha_r = f.next().unwrap_or("").trim().to_string();
    let parents_r = f.next().unwrap_or("").trim().to_string();
    let an = f.next().unwrap_or("").trim().to_string();
    let ae = f.next().unwrap_or("").trim().to_string();
    let ad = f.next().unwrap_or("").trim().parse().unwrap_or(0);
    let cn = f.next().unwrap_or("").trim().to_string();
    let ce = f.next().unwrap_or("").trim().to_string();
    let cd = f.next().unwrap_or("").trim().parse().unwrap_or(0);
    let subject = f.next().unwrap_or("").trim_end().to_string();
    let body = f.next().unwrap_or("").trim_end().to_string();

    // name-status + numstat against first parent. Explicit `<sha>^1 <sha>` for
    // commits with parents (merges included): diff-tree -m would emit one diff
    // per parent, duplicating files; plain diff-tree prints nothing for merges.
    let base = ["diff-tree".to_string(), "-r".to_string(), "-z".to_string(), "--no-commit-id".to_string()];
    let (has_parent, head_sha) = if parents_r.is_empty() {
        (false, sha.to_string())
    } else {
        (true, parents_r.split_whitespace().next().unwrap_or(sha).to_string())
    };
    let mut ns_args: Vec<String> = base.to_vec();
    ns_args.push("--name-status".into());
    if !has_parent {
        ns_args.push("--root".into());
    }
    if has_parent {
        ns_args.push(head_sha.clone());
    }
    ns_args.push(sha.to_string());
    let ns = run_git(&worktree, &ns_args, GitKind::ReadOnly).await?;
    let entries = parse_name_status(&ns.stdout);

    let mut num_args: Vec<String> = base.to_vec();
    num_args.push("--numstat".into());
    if !has_parent {
        num_args.push("--root".into());
    }
    if has_parent {
        num_args.push(head_sha.clone());
    }
    num_args.push(sha.to_string());
    let nums = run_git(&worktree, &num_args, GitKind::ReadOnly).await?;
    let num_map = parse_numstat_raw(&nums.stdout);

    let mut files = Vec::new();
    let mut additions = 0;
    let mut deletions = 0;
    for (path, status, orig) in entries {
        let (add, del, binary) = num_map
            .get(&path)
            .or_else(|| orig.as_ref().and_then(|o| num_map.get(o)))
            .map(|t| (t.0, t.1, t.2))
            .unwrap_or((None, None, false));
        if let (Some(a), Some(d)) = (add, del) {
            additions += a;
            deletions += d;
        }
        files.push(CommitFile {
            path,
            orig_path: orig,
            status,
            additions: add,
            deletions: del,
            binary,
        });
    }

    Ok(CommitDetail {
        sha: if sha_r.is_empty() { sha.to_string() } else { sha_r },
        parents: parents_r.split_whitespace().map(|s| s.to_string()).collect(),
        author_name: an,
        author_email: ae,
        author_date: ad,
        committer_name: cn,
        committer_email: ce,
        commit_date: cd,
        subject,
        body,
        additions,
        deletions,
        files,
    })
}

/// Unified diff text of one file within a commit (vs first parent).
/// Merge commits use an explicit first-parent diff — `git show` would emit
/// the *combined* diff, which is empty for cleanly-resolved files.
pub async fn commit_file_diff(path: &str, sha: &str, file: &str) -> Result<String, super::errors::GitError> {
    let (worktree, _) = resolve_repo_paths(path).map_err(|e| {
        super::errors::GitError::new("not-a-repository", e, "resolve-repo", "")
    })?;
    let has_parent = run_git(
        &worktree,
        &["rev-parse".into(), "--verify".into(), "--quiet".into(), format!("{}^1", sha)],
        GitKind::ReadOnly,
    )
    .await
    .is_ok();

    let args = if has_parent {
        vec![
            "diff".into(),
            "--no-color".into(),
            format!("{}^1", sha),
            sha.to_string(),
            "--".into(),
            file.to_string(),
        ]
    } else {
        // root commit: show the full patch against the empty tree
        vec![
            "show".into(),
            "--format=".into(),
            "--no-show-signature".into(),
            "--no-color".into(),
            "--root".into(),
            sha.to_string(),
            "--".into(),
            file.to_string(),
        ]
    };
    let out = run_git(&worktree, &args, GitKind::ReadOnly).await?;
    Ok(out.stdout)
}

/// Unified diff of a working-tree file (vs index, or index vs HEAD when staged).
pub async fn worktree_file_diff(path: &str, file: &str, staged: bool) -> Result<String, super::errors::GitError> {
    let (worktree, _) = resolve_repo_paths(path).map_err(|e| {
        super::errors::GitError::new("not-a-repository", e, "resolve-repo", "")
    })?;
    let mut args = vec!["diff".to_string(), "--no-color".to_string()];
    if staged {
        args.push("--cached".into());
        args.push("--".into());
        args.push(file.to_string());
    } else if is_untracked(&worktree, file).await {
        // untracked files are invisible to every repo diff form (they are in
        // neither index nor any tree — even `git diff <empty-tree> -- path`
        // prints nothing) — `--no-index /dev/null <file>` is the only form
        // that sees them, showing the whole file as additions. It exits 1
        // on differences, which run_git_diff_no_index tolerates.
        let abs = worktree.join(file);
        let out = run_git_diff_no_index(
            &worktree,
            &[
                "diff".to_string(),
                "--no-color".to_string(),
                "--no-index".to_string(),
                "/dev/null".to_string(),
                abs.to_string_lossy().into_owned(),
            ],
        )
        .await?;
        return Ok(out.stdout);
    } else {
        args.push("--".into());
        args.push(file.to_string());
    }
    let out = run_git(&worktree, &args, GitKind::ReadOnly).await?;
    Ok(out.stdout)
}

/// `git ls-files --others --exclude-standard` lists the path iff untracked.
async fn is_untracked(worktree: &Path, file: &str) -> bool {
    run_git(
        worktree,
        &[
            "ls-files".into(),
            "--others".into(),
            "--exclude-standard".into(),
            "-z".into(),
            "--".into(),
            file.to_string(),
        ],
        GitKind::ReadOnly,
    )
    .await
    .map(|o| !o.stdout.trim_matches('\0').is_empty())
    .unwrap_or(false)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_status() {
        let input = "M\0f1.txt\0A\0f2.txt\0R100\0old.txt\0new.txt\0D\0f3.txt\0";
        let entries = parse_name_status(input);
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0], ("f1.txt".into(), "M".into(), None));
        assert_eq!(entries[2], ("new.txt".into(), "R".into(), Some("old.txt".into())));
        assert_eq!(entries[3], ("f3.txt".into(), "D".into(), None));
    }

    #[tokio::test]
    async fn reads_commit_detail() {
        let tmp = std::env::temp_dir().join(format!("sirgit-detail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git").args(args).current_dir(&tmp)
                .env("GIT_AUTHOR_NAME", "Alice").env("GIT_AUTHOR_EMAIL", "a@x")
                .env("GIT_COMMITTER_NAME", "Alice").env("GIT_COMMITTER_EMAIL", "a@x")
                .output().unwrap()
        };
        assert!(git(&["init", "-q"]).status.success());
        std::fs::write(tmp.join("a.txt"), "one\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "first commit"]).status.success());
        let out = git(&["rev-parse", "HEAD"]);
        let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();

        std::fs::write(tmp.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(tmp.join("b.txt"), "new file\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "second commit", "-m", "body here"]).status.success());

        let d = commit_detail(tmp.to_str().unwrap(), &sha).await.unwrap();
        assert_eq!(d.subject, "first commit");
        assert_eq!(d.author_name, "Alice");
        assert_eq!(d.files.len(), 1);
        assert_eq!(d.files[0].path, "a.txt");
        assert_eq!(d.files[0].additions, Some(1));

        let diff = commit_file_diff(tmp.to_str().unwrap(), &sha, "a.txt").await.unwrap();
        assert!(diff.contains("+one"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn untracked_worktree_diff_shows_full_additions() {
        let tmp = std::env::temp_dir().join(format!("sirgit-untracked-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git").args(args).current_dir(&tmp)
                .env("GIT_AUTHOR_NAME", "T").env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T").env("GIT_COMMITTER_EMAIL", "t@t")
                .output().unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        std::fs::write(tmp.join("a.txt"), "one\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c1"]).status.success());

        // untracked file: `git diff` alone prints nothing for it
        std::fs::write(tmp.join("new.txt"), "hello\nworld\n").unwrap();
        let plain = git(&["diff", "--", "new.txt"]);
        assert!(plain.stdout.is_empty());

        let diff = worktree_file_diff(tmp.to_str().unwrap(), "new.txt", false).await.unwrap();
        assert!(diff.contains("+hello"), "full additions shown, got: {diff}");
        assert!(diff.contains("+world"));
        assert!(diff.contains("new file"));

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
