//! Mutation operations. All run through the per-repo write lock at the API layer,
//! so `index.lock` races are impossible by design (ungit papered over them with retries).

use std::path::Path;

use super::proc::{run_git, run_git_with_stdin, GitKind};
use super::repo::resolve_repo_paths;

fn repo_or_err(path: &str) -> Result<std::path::PathBuf, super::errors::GitError> {
    resolve_repo_paths(path)
        .map(|(w, _)| w)
        .map_err(|e| super::errors::GitError::new("not-a-repository", e, "resolve-repo", ""))
}

pub async fn stage(repo: &str, files: &[String]) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(files.iter().cloned());
    run_git(&w, &args, GitKind::Mutation).await.map(|_| ())
}

pub async fn unstage(repo: &str, files: &[String]) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let mut args = vec!["restore".to_string(), "--staged".to_string(), "--".to_string()];
    args.extend(files.iter().cloned());
    run_git(&w, &args, GitKind::Mutation).await.map(|_| ())
}

/// Discard: tracked files reset to HEAD (index + worktree), untracked files deleted.
pub async fn discard(repo: &str, files: &[String], untracked: &[String]) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    if !untracked.is_empty() {
        for f in untracked {
            let p = w.join(f);
            if p.is_file() {
                std::fs::remove_file(&p).map_err(super::errors::GitError::io)?;
            } else if p.is_dir() {
                std::fs::remove_dir_all(&p).map_err(super::errors::GitError::io)?;
            }
        }
    }
    let tracked: Vec<String> = files.iter().filter(|f| !untracked.contains(f)).cloned().collect();
    if tracked.is_empty() {
        return Ok(());
    }
    // tracked-in-HEAD files restore in one spawn. A file that is NOT in HEAD
    // (a brand-new file the default-staged workflow staged within 400 ms)
    // makes the whole batch fail with "pathspec did not match" — fall back to
    // per-file: restore what HEAD knows, and `rm -f` the new ones out of the
    // index AND the worktree (discard of a new file means "make it go away").
    let mut args = vec!["checkout".to_string(), "HEAD".to_string(), "--".to_string()];
    args.extend(tracked.iter().cloned());
    if run_git(&w, &args, GitKind::Mutation).await.is_ok() {
        return Ok(());
    }
    for f in &tracked {
        let restore = vec!["checkout".to_string(), "HEAD".to_string(), "--".to_string(), f.clone()];
        if run_git(&w, &restore, GitKind::Mutation).await.is_err() {
            let rm = vec!["rm".to_string(), "-f".to_string(), "--".to_string(), f.clone()];
            run_git(&w, &rm, GitKind::Mutation).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod discard_tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) -> std::process::Output {
        std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("LC_ALL", "C")
            .output()
            .unwrap()
    }

    /// Discarding a STAGED NEW file (absent from HEAD) used to fail the whole
    /// batch with "pathspec did not match" — the file must leave index and
    /// worktree, and known files must still restore in the same call.
    #[tokio::test]
    async fn discard_handles_staged_new_files() {
        let tmp = std::env::temp_dir().join(format!("sirgit-discard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(git(&tmp, &["init", "-q", "-b", "main"]).status.success());
        assert!(git(&tmp, &["config", "user.name", "T"]).status.success());
        assert!(git(&tmp, &["config", "user.email", "t@sirgit.test"]).status.success());
        std::fs::write(tmp.join("a.txt"), "one\n").unwrap();
        assert!(git(&tmp, &["add", "."]).status.success());
        assert!(git(&tmp, &["commit", "-q", "-m", "c1"]).status.success());

        std::fs::write(tmp.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(tmp.join("new.txt"), "fresh\n").unwrap();
        assert!(git(&tmp, &["add", "."]).status.success());
        assert!(git(&tmp, &["status", "--porcelain"]).stdout.starts_with(b"M  "));

        discard(tmp.to_str().unwrap(), &["a.txt".into(), "new.txt".into()], &[]).await.unwrap();
        assert_eq!(std::fs::read_to_string(tmp.join("a.txt")).unwrap(), "one\n", "tracked file restored");
        assert!(!tmp.join("new.txt").exists(), "staged new file deleted");
        let left = String::from_utf8_lossy(&git(&tmp, &["status", "--porcelain"]).stdout).into_owned();
        assert!(left.trim().is_empty(), "worktree clean again, got {left:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

pub async fn commit(
    repo: &str,
    message: &str,
    amend: bool,
    allow_empty: bool,
) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let mut args = vec!["commit".to_string(), "--file=-".to_string()];
    if amend {
        // fold the CURRENT worktree state into the amended commit (add -A):
        // the user's model of amend is "HEAD + what I have now" — a staged-
        // only amend silently dropped unstaged changes when the commit box
        // enabled on amend alone. Clean tree: add -A is a no-op, so message-
        // only amends keep working.
        run_git(&w, &["add".into(), "-A".into()], GitKind::Mutation).await?;
        args.push("--amend".into());
    }
    if allow_empty {
        args.push("--allow-empty".into());
    }
    run_git_with_stdin(&w, &args, message, GitKind::Mutation).await.map(|_| ())
}

/// What to do with uncommitted changes when switching branches (the client
/// asks the user first when the worktree is dirty): Bring = stash →
/// checkout → pop, so the changes follow to the target branch; Stash =
/// stash → checkout, leaving them on the stash stack.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
pub enum CarryChanges {
    #[serde(rename = "bring")]
    Bring,
    #[serde(rename = "stash")]
    Stash,
}

pub async fn checkout(
    repo: &str,
    ref_name: &str,
    remote: Option<&str>,
    carry: Option<CarryChanges>,
) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    // stash the dirty state first when asked — remember whether a stash
    // entry actually got created ("no local changes to save" exits 0 but
    // stashes nothing; popping then would grab an OLDER entry or fail)
    let stashed = match carry {
        Some(_) => stash_if_dirty(&w).await?,
        None => false,
    };
    if let Err(e) = do_checkout(&w, ref_name, remote).await {
        // checkout refused — pop the stash back so the worktree is exactly
        // as it was (best effort: the original error matters more)
        if stashed {
            let _ = super::stash::apply(repo, 0, true).await;
        }
        return Err(e);
    }
    if carry == Some(CarryChanges::Bring) && stashed {
        super::stash::apply(repo, 0, true).await.map_err(|e| {
            super::errors::GitError::new(
                "stash-conflict",
                format!(
                    "Checked out {}, but restoring your stashed changes conflicted — resolve them in the staging area; the stash entry is kept.",
                    ref_name
                ),
                "stash pop",
                e.stderr,
            )
        })?;
    }
    Ok(())
}

async fn do_checkout(
    w: &std::path::Path,
    ref_name: &str,
    remote: Option<&str>,
) -> Result<(), super::errors::GitError> {
    match remote {
        None => run_git(w, &["checkout".into(), ref_name.to_string()], GitKind::Mutation).await.map(|_| ()),
        Some(remote) => {
            // `remote` arrives as either a remote NAME ("origin" — the
            // sidebar's create-tracking checkout) or a FULL remote-tracking
            // ref ("origin/x" — older graph-path callers). A '/' means the
            // tracking ref itself was passed and ref_name is already the
            // local branch name; composing "{remote}/{local}" from THAT gave
            // `git checkout -b x --track origin/x/x` and always failed.
            let (track_ref, local) = match remote.split_once('/') {
                Some(_) => (remote.to_string(), ref_name.to_string()),
                None => (format!("{}/{}", remote, ref_name), ref_name.to_string()),
            };
            let args = vec![
                "checkout".into(),
                "-b".into(),
                local,
                "--track".into(),
                track_ref,
            ];
            run_git(w, &args, GitKind::Mutation).await.map(|_| ())
        }
    }
}

/// `git stash push --include-untracked`, reporting whether a NEW stash entry
/// was actually created (refs/stash moved) — guards the pop that follows a
/// "bring" carry and the undo-pop when the checkout refuses.
async fn stash_if_dirty(w: &std::path::Path) -> Result<bool, super::errors::GitError> {
    let before = stash_tip(w).await;
    run_git(
        w,
        &[
            "stash".into(),
            "push".into(),
            "--include-untracked".into(),
            "--message".into(),
            "sirgit: checkout".into(),
        ],
        GitKind::Mutation,
    )
    .await?;
    let after = stash_tip(w).await;
    Ok(after.is_some() && after != before)
}

async fn stash_tip(w: &std::path::Path) -> Option<String> {
    run_git(
        w,
        &["rev-parse".into(), "-q".into(), "--verify".into(), "refs/stash".into()],
        GitKind::ReadOnly,
    )
    .await
    .ok()
    .map(|o| o.stdout.trim().to_string())
    .filter(|s| !s.is_empty())
}

/// Drop the last commit of the current branch, keeping its changes staged.
pub async fn uncommit(repo: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    run_git(&w, &["reset".to_string(), "HEAD^".to_string(), "--mixed".to_string()], GitKind::Mutation)
        .await
        .map(|_| ())
}

/// Rename a local branch: create new ref at old's sha, delete old. Upstream is not migrated.
pub async fn rename_branch(repo: &str, old: &str, new: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    // `branch -m` also works on the checked-out branch (moves the HEAD symref);
    // create+delete would fail because git refuses to delete the current branch.
    run_git(&w, &["branch".to_string(), "-m".to_string(), old.to_string(), new.to_string()], GitKind::Mutation).await.map(|_| ())
}

/// Rename a tag (create at old's target, delete old). An ANNOTATED tag keeps
/// its annotation: a plain `git tag <new> <old>` would create a LIGHTWEIGHT
/// tag pointing at the tag object — message and tagger gone. The old tag
/// object's message is re-fed through `tag -a -F -`, mirroring move_tag.
pub async fn rename_tag(repo: &str, old: &str, new: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let kind = run_git(
        &w,
        &["cat-file".to_string(), "-t".to_string(), format!("refs/tags/{}", old)],
        GitKind::ReadOnly,
    )
    .await?;
    if kind.stdout.trim() == "tag" {
        let msg = run_git(
            &w,
            &[
                "for-each-ref".to_string(),
                "--format=%(contents)".to_string(),
                format!("refs/tags/{}", old),
            ],
            GitKind::ReadOnly,
        )
        .await?;
        run_git_with_stdin(
            &w,
            &[
                "tag".to_string(),
                "-a".to_string(),
                new.to_string(),
                "-F".to_string(),
                "-".to_string(),
                old.to_string(),
            ],
            msg.stdout.as_str(),
            GitKind::Mutation,
        )
        .await?;
    } else {
        run_git(&w, &["tag".to_string(), new.to_string(), old.to_string()], GitKind::Mutation).await?;
    }
    run_git(&w, &["tag".to_string(), "-d".to_string(), old.to_string()], GitKind::Mutation).await.map(|_| ())
}

/// Squash a branch's tip segment (first-parent chain tip→base) into one commit.
/// - current branch: `reset --soft <base>` — the segment's changes stay staged;
///   the gathered message is returned for the UI's commit-box prefill
/// - other local branch: one NEW commit with the branch tip's tree on top of
///   <base> (`commit-tree` + `update-ref`) — pure ref surgery, no worktree
///   involved, conflicts impossible; commits below the segment stay put
pub async fn squash(repo: &str, branch: &str, base: &str) -> Result<Option<(String, String)>, super::errors::GitError> {
    let w = repo_or_err(repo)?;
    // gather the segment's messages BEFORE any ref moves (log walks the ref)
    let log = run_git(
        &w,
        &[
            "log".into(),
            "--reverse".into(),
            "--first-parent".into(),
            format!("{base}..{branch}"),
            "--format=%s%x1f%b%x1e".into(),
        ],
        GitKind::ReadOnly,
    )
    .await?;
    let commits: Vec<(String, String)> = log
        .stdout
        .split('\x1e')
        .map(|r| r.trim_matches('\n'))
        .filter(|r| !r.is_empty())
        .map(|r| {
            let mut parts = r.splitn(2, '\x1f');
            let subject = parts.next().unwrap_or("").trim().to_string();
            let body = parts.next().unwrap_or("").trim().to_string();
            (subject, body)
        })
        .collect();
    let (title, body) = if commits.len() == 1 {
        commits.into_iter().next().unwrap()
    } else if commits.is_empty() {
        (format!("Squash commits from {branch}"), String::new())
    } else {
        let title = format!("Squash {} commits from {}", commits.len(), branch);
        let body = commits
            .into_iter()
            .map(|(s, b)| if b.is_empty() { format!("* {s}") } else { format!("* {s}\n\n{b}") })
            .collect::<Vec<_>>()
            .join("\n\n");
        (title, body)
    };

    let head = run_git(&w, &["symbolic-ref".to_string(), "-q".to_string(), "--short".to_string(), "HEAD".to_string()], GitKind::ReadOnly).await?;
    let current = head.stdout.trim().to_string();
    if branch == current {
        run_git(&w, &["reset".to_string(), "--soft".to_string(), base.to_string()], GitKind::Mutation).await?;
        Ok(Some((title, body)))
    } else {
        let tree = run_git(&w, &["rev-parse".into(), format!("{branch}^{{tree}}")], GitKind::ReadOnly).await?;
        let message = if body.is_empty() { title.clone() } else { format!("{title}\n\n{body}") };
        let new = run_git_with_stdin(
            &w,
            &["commit-tree".into(), tree.stdout.trim().to_string(), "-p".into(), base.to_string()],
            &message,
            GitKind::Mutation,
        )
        .await?;
        run_git(
            &w,
            &["update-ref".to_string(), format!("refs/heads/{}", branch), new.stdout.trim().to_string()],
            GitKind::Mutation,
        )
        .await?;
        Ok(None)
    }
}

/// Move a branch ref onto another commit.
/// - current branch: `reset --hard <target>` — branch, HEAD and worktree move together
/// - other local branch: plain ref move (`update-ref`) — unique commits are dropped
pub async fn move_branch(repo: &str, branch: &str, target: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let head = run_git(&w, &["symbolic-ref".to_string(), "-q".to_string(), "--short".to_string(), "HEAD".to_string()], GitKind::ReadOnly).await?;
    let current = head.stdout.trim().to_string();
    if branch == current {
        run_git(&w, &["reset".to_string(), "--hard".to_string(), target.to_string()], GitKind::Mutation)
            .await
            .map(|_| ())
    } else {
        run_git(
            &w,
            &["update-ref".to_string(), format!("refs/heads/{}", branch), target.to_string()],
            GitKind::Mutation,
        )
        .await
        .map(|_| ())
    }
}

/// Merge `from` into `into`.
/// - `into` is checked out: a real `git merge` (conflicts surface in the staging area);
///   with `squash`: stage everything (`merge --squash` + `add -A`) and return the
///   combined commit message gathered from `from`'s unique commits — the UI
///   prefills its commit box with it, amend-style, and the user commits
/// - otherwise: fast-forward only via a refspec fetch — a non-checked-out branch
///   has no worktree to resolve a merge (or stage a squash) in
pub async fn merge_branch(
    repo: &str,
    from: &str,
    into: &str,
    squash: bool,
) -> Result<Option<(String, String)>, super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let head = run_git(&w, &["symbolic-ref".to_string(), "-q".to_string(), "--short".to_string(), "HEAD".to_string()], GitKind::ReadOnly).await?;
    let current = head.stdout.trim().to_string();
    if into == current {
        if squash {
            run_git(&w, &["merge".to_string(), "--squash".into(), from.to_string()], GitKind::Mutation).await?;
            run_git(&w, &["add".to_string(), "-A".into()], GitKind::Mutation).await?;
            // gather the messages of the squashed commits (HEAD is still `into`)
            let log = run_git(
                &w,
                &[
                    "log".to_string(),
                    "--reverse".to_string(),
                    format!("{}..{}", into, from),
                    "--format=%s%x1f%b%x1e".to_string(),
                ],
                GitKind::ReadOnly,
            )
            .await?;
            let commits: Vec<(String, String)> = log
                .stdout
                .split('\x1e')
                .map(|r| r.trim_matches('\n'))
                .filter(|r| !r.is_empty())
                .map(|r| {
                    let mut parts = r.splitn(2, '\x1f');
                    let subject = parts.next().unwrap_or("").trim().to_string();
                    let body = parts.next().unwrap_or("").trim().to_string();
                    (subject, body)
                })
                .collect();
            let message = if commits.len() == 1 {
                commits.into_iter().next().unwrap()
            } else if commits.is_empty() {
                (format!("Squash merge from {from}"), String::new())
            } else {
                let title = format!("Squash {} commits from {}", commits.len(), from);
                let body = commits
                    .into_iter()
                    .map(|(s, b)| if b.is_empty() { format!("* {s}") } else { format!("* {s}\n\n{b}") })
                    .collect::<Vec<_>>()
                    .join("\n\n");
                (title, body)
            };
            Ok(Some(message))
        } else {
            // --autostash: the default-staged workflow keeps changes staged
            // almost always — a plain rebase refuses ("You have unstaged
            // changes"), which used to surface as a bogus "rebase already in
            // progress". Autostash tucks them away and restores them after.
            run_git(
                &w,
                &["merge".into(), "--autostash".into(), from.to_string()],
                GitKind::Mutation,
            )
            .await
            .map(|_| None)
        }
    } else {
        if squash {
            return Err(super::errors::GitError::new(
                "squash-needs-checkout",
                format!("Cannot squash-merge into \"{into}\" without checking it out — the changes are staged in a worktree. Check out \"{into}\" first."),
                "git merge --squash",
                "",
            ));
        }
        // a fetch refspec would happily CREATE a nonexistent destination — reject it
        run_git(
            &w,
            &["show-ref".to_string(), "--verify".to_string(), "--quiet".to_string(), format!("refs/heads/{}", into)],
            GitKind::ReadOnly,
        )
        .await
        .map_err(|_| {
            super::errors::GitError::new("bad-revision", format!("\"{into}\" is not a local branch"), "git show-ref", "")
        })?;
        run_git(
            &w,
            &["fetch".to_string(), ".".to_string(), format!("{}:{}", from, into)],
            GitKind::Mutation,
        )
        .await
        .map(|_| None)
        .map_err(|e| {
            if e.code == "non-fast-forward" {
                super::errors::GitError::new(
                    "merge-non-fast-forward",
                    format!("Cannot merge into \"{into}\" without checking it out: the merge would not be a fast-forward. Check out \"{into}\" first to create a merge commit."),
                    "git fetch",
                    e.stderr,
                )
            } else {
                e
            }
        })
    }
}

pub async fn create_branch(repo: &str, name: &str, sha: &str, checkout: bool) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let args = vec!["branch".into(), name.to_string(), sha.to_string()];
    run_git(&w, &args, GitKind::Mutation).await.map(|_| ())?;
    if checkout {
        run_git(&w, &["checkout".into(), name.to_string()], GitKind::Mutation).await.map(|_| ())?;
    }
    Ok(())
}

/// Create an orphan commit — no parents, empty tree, on no branch. It is
/// pinned with a ref under refs/sirgit/orphans/ so it survives gc and shows
/// up in `git log --all` (the graph renders it as an isolated node in its
/// own column); read_refs never lists that namespace as a chip.
pub async fn create_orphan(repo: &str, message: &str) -> Result<String, super::errors::GitError> {
    let w = repo_or_err(repo)?;
    // empty tree via mktree with empty stdin — sha-1/sha-256 agnostic
    let tree = run_git_with_stdin(&w, &["mktree".into()], "", GitKind::ReadOnly).await?;
    let tree = tree.stdout.trim().to_string();
    let commit = run_git(
        &w,
        &["commit-tree".into(), tree, "-m".into(), message.to_string()],
        GitKind::Mutation,
    )
    .await?;
    let sha = commit.stdout.trim().to_string();
    let short = &sha[..sha.len().min(12)];
    run_git(
        &w,
        &[
            "update-ref".into(),
            format!("refs/sirgit/orphans/{}", short),
            sha.clone(),
        ],
        GitKind::Mutation,
    )
    .await?;
    Ok(sha)
}

pub async fn delete_branch(repo: &str, name: &str, force: bool) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let flag = if force { "-D" } else { "-d" };
    run_git(&w, &["branch".into(), flag.into(), name.to_string()], GitKind::Mutation).await.map(|_| ())
}

pub async fn create_tag(repo: &str, name: &str, sha: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    run_git(&w, &["tag".into(), name.to_string(), sha.to_string()], GitKind::Mutation).await.map(|_| ())
}

pub async fn delete_tag(repo: &str, name: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    run_git(&w, &["tag".into(), "-d".into(), name.to_string()], GitKind::Mutation).await.map(|_| ())
}

pub async fn resolve_conflicts(repo: &str, files: &[String]) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(files.iter().cloned());
    run_git(&w, &args, GitKind::Mutation).await.map(|_| ())
}

/// Continue a conflicted merge: commit with MERGE_MSG (or provided message).
pub async fn merge_continue(repo: &str, message: Option<&str>) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let msg = match message {
        Some(m) => m.to_string(),
        None => std::fs::read_to_string(w.join(".git").join("MERGE_MSG"))
            .or_else(|_| std::fs::read_to_string(w.join("MERGE_MSG")))
            .unwrap_or_else(|_| "Merge".to_string()),
    };
    run_git_with_stdin(&w, &["commit".into(), "--file=-".into()], &msg, GitKind::Mutation).await.map(|_| ())
}

pub async fn merge_abort(repo: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    // `merge --abort` needs MERGE_HEAD — a CONFLICTED `merge --squash` has
    // only SQUASH_MSG (its changes sit staged, no merge to abort). The abort
    // there is `reset --hard`: the partially-staged squash is discarded and
    // branch + worktree return to HEAD. The client confirms before calling.
    let has_merge_head = w.join(".git").join("MERGE_HEAD").exists();
    let has_squash_msg = w.join(".git").join("SQUASH_MSG").exists();
    if !has_merge_head && has_squash_msg {
        return run_git(&w, &["reset".into(), "--hard".into(), "HEAD".into()], GitKind::Mutation).await.map(|_| ());
    }
    run_git(&w, &["merge".into(), "--abort".into()], GitKind::Mutation).await.map(|_| ())
}

pub async fn rebase_continue(repo: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    run_git(&w, &["rebase".into(), "--continue".into()], GitKind::Mutation)
        .await
        .map(|_| ())
}

pub async fn rebase_abort(repo: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    run_git(&w, &["rebase".into(), "--abort".into()], GitKind::Mutation).await.map(|_| ())
}

/// Rebase the current branch onto `onto` (branch name or sha). Conflicts
/// pause the rebase — the staging area then offers continue/abort.
/// --autostash: the default-staged workflow keeps changes staged nearly
/// always; a bare rebase refuses with "You have unstaged changes", which the
/// old classifier mislabeled as "a rebase is already in progress".
pub async fn rebase_start(repo: &str, onto: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    run_git(
        &w,
        &["rebase".into(), "--autostash".into(), onto.to_string()],
        GitKind::Mutation,
    )
    .await
    .map(|_| ())
}

/// Cherry-pick a commit onto HEAD. Conflicts pause the pick — the staging
/// area offers continue/abort like merge/revert/rebase.
pub async fn cherry_pick(repo: &str, sha: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    run_git(&w, &["cherry-pick".into(), sha.to_string()], GitKind::Mutation).await.map(|_| ())
}

pub async fn cherry_pick_continue(repo: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    run_git(&w, &["cherry-pick".into(), "--continue".into()], GitKind::Mutation)
        .await
        .map(|_| ())
}

pub async fn cherry_pick_abort(repo: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    run_git(&w, &["cherry-pick".into(), "--abort".into()], GitKind::Mutation)
        .await
        .map(|_| ())
}

/// Revert a commit: a new commit undoing its changes (`git revert --no-edit`).
/// Conflicts pause the revert — the staging area offers continue/abort.
pub async fn revert_commit(repo: &str, sha: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    run_git(&w, &["revert".into(), "--no-edit".into(), sha.to_string()], GitKind::Mutation).await.map(|_| ())
}

pub async fn revert_continue(repo: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    run_git(&w, &["revert".into(), "--continue".into()], GitKind::Mutation).await.map(|_| ())
}

pub async fn revert_abort(repo: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    run_git(&w, &["revert".into(), "--abort".into()], GitKind::Mutation).await.map(|_| ())
}

pub async fn init_repo(path: &Path, bare: bool) -> Result<(), super::errors::GitError> {
    let parent = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(path).map_err(super::errors::GitError::io)?;
    let mut args = vec!["init".to_string()];
    if bare {
        args.push("--bare".into());
    }
    args.push(path.to_string_lossy().into_owned());
    run_git(parent, &args, GitKind::Mutation).await.map(|_| ())
}

/// Build the `-c credential.helper=...` args routing git's credential prompts
/// through our local HTTP endpoint (same proven protocol concept as ungit,
/// implemented with an inline shell helper — no second binary needed).
pub fn credential_args(port: u16, op_id: &str, remote_b64: &str) -> Vec<String> {
    let url = format!("http://127.0.0.1:{}/api/credentials?op={}&remote={}", port, op_id, remote_b64);
    let helper = format!(
        "!f() {{ curl -s --max-time 130 '{}'; }}; f",
        url
    );
    vec![
        "-c".into(),
        "credential.helper=".into(),
        "-c".into(),
        format!("credential.helper={}", helper),
    ]
}

/// Fetch with optional credential injection. Progress goes to stderr.
pub async fn fetch(
    repo: &str,
    remote: &str,
    prune: bool,
    extra: &[String],
) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let mut args: Vec<String> = extra.to_vec();
    args.push("fetch".into());
    if prune {
        args.push("--prune".into());
    }
    args.push(remote.to_string());
    run_git(&w, &args, GitKind::Network).await?;
    // which tags exist on the remote now (drives og/<tag> in the UI);
    // best-effort — a failed ls-remote keeps the previous cache
    let _ = super::remote_tags::refresh(repo, remote).await;
    Ok(())
}

/// Push. refspec is e.g. "main" or "main:main" or "refs/tags/v1:refs/tags/v1".
pub async fn push(repo: &str, remote: &str, refspec: &str, force: bool, set_upstream: bool, extra: &[String]) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let mut args: Vec<String> = extra.to_vec();
    args.push("push".into());
    if force {
        // lease: refuses if the remote moved since the last fetch — safer than --force
        args.push("--force-with-lease".into());
    }
    // first push of a branch: -u records the upstream so Pull/behind-↑N work
    if set_upstream && !refspec.starts_with("refs/tags/") && !refspec.starts_with(':') && !refspec.contains(':') {
        args.push("-u".into());
    }
    args.push(remote.to_string());
    args.push(refspec.to_string());
    run_git(&w, &args, GitKind::Network).await?;
    // the push may have shipped a tag — refresh the remote-tag cache so its
    // chip flips to og/<tag> on the refs re-poll this op's completion bumps
    let _ = super::remote_tags::refresh(repo, remote).await;
    Ok(())
}

/// Move a tag onto another commit. An ANNOTATED tag keeps its message: the
/// old tag object's contents are re-fed via `tag -f -a -F -` (a plain
/// `update-ref` would silently flatten it to a lightweight tag — the
/// annotation, message and tagger would be gone). Local-only by design:
/// tags on the remote are published releases and the UI refuses to drag
/// them; this op never touches the remote.
pub async fn move_tag(repo: &str, tag: &str, target: &str) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let kind = run_git(
        &w,
        &["cat-file".to_string(), "-t".to_string(), format!("refs/tags/{}", tag)],
        GitKind::ReadOnly,
    )
    .await?;
    if kind.stdout.trim() == "tag" {
        let msg = run_git(
            &w,
            &[
                "for-each-ref".to_string(),
                "--format=%(contents)".to_string(),
                format!("refs/tags/{}", tag),
            ],
            GitKind::ReadOnly,
        )
        .await?;
        run_git_with_stdin(
            &w,
            &[
                "tag".to_string(),
                "-f".to_string(),
                "-a".to_string(),
                tag.to_string(),
                "-F".to_string(),
                "-".to_string(),
                target.to_string(),
            ],
            msg.stdout.as_str(),
            GitKind::Mutation,
        )
        .await
        .map(|_| ())
    } else {
        run_git(
            &w,
            &["update-ref".to_string(), format!("refs/tags/{}", tag), target.to_string()],
            GitKind::Mutation,
        )
        .await
        .map(|_| ())
    }
}

/// Fast-forward local `branch` onto the remote-tracking ref (NO network —
/// the graph's remote chip already pins the target; Fetch refreshes it).
/// - current branch: `merge --ff-only <remote_ref>` — the worktree follows,
///   divergence and conflicting local edits are refused by git
/// - other branch: `fetch . refs/remotes/<r>:refs/heads/<b>` — the refspec
///   refuses non-ff by construction and git refuses the checked-out branch,
///   so both dangerous shapes are impossible
/// `checkout` then switches to the branch (non-current branches only).
pub async fn ff_branch(repo: &str, branch: &str, remote_ref: &str, checkout: bool) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let head = run_git(&w, &["symbolic-ref".to_string(), "-q".to_string(), "--short".to_string(), "HEAD".to_string()], GitKind::ReadOnly).await?;
    let current = head.stdout.trim().to_string();
    if branch == current {
        run_git(&w, &["merge".to_string(), "--ff-only".to_string(), remote_ref.to_string()], GitKind::Mutation).await?;
    } else {
        run_git(
            &w,
            &[
                "fetch".to_string(),
                ".".to_string(),
                format!("refs/remotes/{}:refs/heads/{}", remote_ref, branch),
            ],
            GitKind::Mutation,
        )
        .await?;
        if checkout {
            run_git(&w, &["checkout".to_string(), branch.to_string()], GitKind::Mutation).await?;
        }
    }
    Ok(())
}

/// DESTRUCTIVE counterpart of ff_branch: force the local branch onto the
/// remote-tracking ref, dropping commits the remote doesn't have (reflog
/// only). The client only reaches this through an explicit danger confirm.
pub async fn reset_branch_to(repo: &str, branch: &str, remote_ref: &str, checkout: bool) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let head = run_git(&w, &["symbolic-ref".to_string(), "-q".to_string(), "--short".to_string(), "HEAD".to_string()], GitKind::ReadOnly).await?;
    let current = head.stdout.trim().to_string();
    if branch == current {
        run_git(&w, &["reset".to_string(), "--hard".to_string(), remote_ref.to_string()], GitKind::Mutation).await?;
    } else {
        run_git(
            &w,
            &[
                "update-ref".to_string(),
                format!("refs/heads/{}", branch),
                format!("refs/remotes/{}", remote_ref),
            ],
            GitKind::Mutation,
        )
        .await?;
        if checkout {
            run_git(&w, &["checkout".to_string(), branch.to_string()], GitKind::Mutation).await?;
        }
    }
    Ok(())
}

/// Pull = fetch + fast-forward-only merge of the current branch's upstream.
/// Pull = fetch + fast-forward the target branch to its upstream.
/// - Current branch: fetch remote, then `merge --ff-only remote/branch`.
/// - Any other branch (no checkout needed): `fetch remote <upstream>:<branch>`
///   — the refspec refuses non-fast-forward by default, so it is safe.
pub async fn pull(repo: &str, branch: Option<&str>, extra: &[String]) -> Result<(), super::errors::GitError> {
    let w = repo_or_err(repo)?;
    let head = run_git(&w, &["symbolic-ref".to_string(), "-q".to_string(), "--short".to_string(), "HEAD".to_string()], GitKind::ReadOnly).await?;
    let current = head.stdout.trim().to_string();
    let branch = branch.unwrap_or(&current).to_string();

    // resolve the branch's upstream: branch.<name>.remote + .merge
    let cfg = run_git(
        &w,
        &[
            "config".to_string(),
            "--get".to_string(),
            format!("branch.{}.remote", branch),
        ],
        GitKind::ReadOnly,
    )
    .await
    .map_err(|_| super::errors::GitError::new("no-upstream", format!("branch {} has no upstream", branch), "git config", ""))?;
    let remote = cfg.stdout.trim().to_string();
    let merge_ref = run_git(
        &w,
        &[
            "config".to_string(),
            "--get".to_string(),
            format!("branch.{}.merge", branch),
        ],
        GitKind::ReadOnly,
    )
    .await
    .map(|o| o.stdout.trim().trim_start_matches("refs/heads/").to_string())
    .unwrap_or_else(|_| branch.clone());

    if branch == current {
        let mut fargs: Vec<String> = extra.to_vec();
        fargs.push("fetch".to_string());
        // prune: branches deleted on the remote must drop out of the
        // remote-tracking refs on pull too, not only on Fetch
        fargs.push("--prune".to_string());
        fargs.push(remote.clone());
        run_git(&w, &fargs, GitKind::Network).await?;

        let mut margs = vec!["merge".to_string(), "--ff-only".to_string()];
        if remote == "." {
            margs.push(merge_ref);
        } else {
            margs.push(format!("{}/{}", remote, merge_ref));
        }
        run_git(&w, &margs, GitKind::Mutation).await?;
    } else {
        // fast-forward a non-checked-out branch: refspec without "+" refuses non-ff
        let mut fargs: Vec<String> = extra.to_vec();
        fargs.push("fetch".to_string());
        fargs.push(remote.clone());
        fargs.push(format!("{}:{}", merge_ref, branch));
        run_git(&w, &fargs, GitKind::Network).await?;
    }
    // pull talked to the remote — refresh the remote-tag cache too
    if remote != "." {
        let _ = super::remote_tags::refresh(repo, &remote).await;
    }
    Ok(())
}

/// Clone into `dir`. Long-running; caller surfaces stderr as progress.
pub async fn clone_repo(
    url: &str,
    dir: &Path,
    recurse_submodules: bool,
    port: u16,
    op_id: &str,
) -> Result<(), super::errors::GitError> {
    let parent = dir.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(super::errors::GitError::io)?;
    let remote_b64 = b64_url(url.as_bytes());
    let mut args = credential_args(port, op_id, &remote_b64);
    args.push("clone".into());
    args.push("--progress".into());
    if recurse_submodules {
        args.push("--recurse-submodules".into());
    }
    args.push(url.to_string());
    args.push(dir.to_string_lossy().into_owned());
    run_git(parent, &args, GitKind::Clone).await.map(|_| ())
}

pub fn b64_url(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '-' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '-' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fast-forwarding onto a remote-tracking ref: current branch merges
    /// --ff-only (worktree follows), other branches move via the local
    /// refspec fetch + optional checkout, and divergence is refused.
    #[tokio::test]
    async fn ff_branch_moves_current_other_and_refuses_divergence() {
        let tmp = std::env::temp_dir().join(format!("sirgit-fftest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&tmp)
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        assert!(git(&["config", "user.name", "T"]).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"]).status.success());
        let c = |msg: &str, file: &str, body: &str| {
            std::fs::write(tmp.join(file), body).unwrap();
            assert!(git(&["add", "."]).status.success());
            assert!(git(&["commit", "-q", "-m", msg]).status.success());
            String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout).trim().to_string()
        };
        let c1 = c("c1", "a.txt", "one\n");
        let c2 = c("c2", "b.txt", "two\n");
        // pretend the remote moved to c2 while local main and other both sit at c1
        assert!(git(&["update-ref", "refs/remotes/origin/main", &c2]).status.success());
        assert!(git(&["branch", "other", &c1]).status.success());
        assert!(git(&["update-ref", "refs/remotes/origin/other", &c2]).status.success());

        // current branch: fast-forward + worktree follows
        ff_branch(tmp.to_str().unwrap(), "main", "origin/main", false).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&git(&["rev-parse", "main"]).stdout).trim(), c2);
        assert!(tmp.join("b.txt").exists(), "worktree must follow the ff");

        // divergence while main is still checked out: main moves to c3 while
        // the "remote" gains c2b — a sibling commit off c1 (merge --ff-only
        // of an ANCESTOR is a no-op "up to date", not divergence). The ff
        // must refuse (would lose c3) and the explicit reset lands it.
        let c3 = c("c3", "c.txt", "three\n");
        let tree = String::from_utf8_lossy(&git(&["rev-parse", &format!("{}^{{tree}}", c2)]).stdout).trim().to_string();
        let c2b = String::from_utf8_lossy(&git(&["commit-tree", &tree, "-p", &c1, "-m", "remote side"]).stdout)
            .trim()
            .to_string();
        assert!(git(&["update-ref", "refs/remotes/origin/main", &c2b]).status.success());
        assert!(
            ff_branch(tmp.to_str().unwrap(), "main", "origin/main", false).await.is_err(),
            "diverged fast-forward must refuse"
        );
        assert_eq!(
            String::from_utf8_lossy(&git(&["rev-parse", "main"]).stdout).trim(),
            c3,
            "refused ff must not move main"
        );
        reset_branch_to(tmp.to_str().unwrap(), "main", "origin/main", false).await.unwrap();
        assert_eq!(
            String::from_utf8_lossy(&git(&["rev-parse", "main"]).stdout).trim(),
            c2b,
            "reset must land main on the remote's commit"
        );
        assert!(!tmp.join("c.txt").exists(), "reset --hard must drop the diverged commit's files");

        // non-current branch: refspec ff + checkout
        ff_branch(tmp.to_str().unwrap(), "other", "origin/other", true).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&git(&["rev-parse", "other"]).stdout).trim(), c2);
        assert_eq!(String::from_utf8_lossy(&git(&["symbolic-ref", "--short", "HEAD"]).stdout).trim(), "other");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn b64_url_matches_reference() {
        // RFC 4648 test vectors, URL-safe alphabet
        assert_eq!(b64_url(b""), "");
        assert_eq!(b64_url(b"f"), "Zg--");
        assert_eq!(b64_url(b"fo"), "Zm8-");
        assert_eq!(b64_url(b"foo"), "Zm9v");
        assert_eq!(b64_url(b"foobar"), "Zm9vYmFy");
    }

    /// Amend folds the CURRENT worktree state into the rewritten commit
    /// (user rule: "amend commits should include changes of README.md") —
    /// both a modified tracked file and a brand-new one, staged or not; a
    /// clean tree still amends message-only.
    #[tokio::test]
    async fn amend_folds_current_worktree_changes() {
        let tmp = std::env::temp_dir().join(format!("sirgit-amend-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&tmp)
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        assert!(git(&["config", "user.name", "T"]).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"]).status.success());
        std::fs::write(tmp.join("README.md"), "original\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c1"]).status.success());
        let p = tmp.to_str().unwrap();
        let head_readme = || String::from_utf8(git(&["show", "HEAD:README.md"]).stdout).unwrap();
        let clean = || String::from_utf8_lossy(&git(&["status", "--porcelain"]).stdout).trim().is_empty();

        // case 1: README modified (unstaged!) + a brand-new file — both fold in
        std::fs::write(tmp.join("README.md"), "original\nplus new line\n").unwrap();
        std::fs::write(tmp.join("NEW.md"), "new file\n").unwrap();
        commit(p, "amended", true, true).await.unwrap();
        assert_eq!(head_readme(), "original\nplus new line\n", "amend must include the worktree README changes");
        assert_eq!(String::from_utf8(git(&["show", "HEAD:NEW.md"]).stdout).unwrap(), "new file\n");
        assert!(clean(), "amend consumed the worktree changes");

        // case 2: message-only amend on a clean tree still works (same subject rewritten)
        commit(p, "message tweak", true, true).await.unwrap();
        assert!(String::from_utf8_lossy(&git(&["log", "-1", "--format=%s"]).stdout).trim() == "message tweak");
        assert!(clean());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// checkout carry: a dirty worktree either follows to the target branch
    /// (Bring = stash → checkout → pop, stash stack empty afterwards) or
    /// stays on the stack (Stash = stash → checkout, worktree clean); a
    /// REFUSED checkout pops the stash back (worktree exactly as it was),
    /// and Bring on a clean tree must not touch the stash at all.
    #[tokio::test]
    async fn checkout_carries_or_stashes_dirty_worktree() {
        let tmp = std::env::temp_dir().join(format!("sirgit-carry-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&tmp)
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        assert!(git(&["config", "user.name", "T"]).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"]).status.success());
        std::fs::write(tmp.join("a.txt"), "one\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c1"]).status.success());
        assert!(git(&["branch", "other"]).status.success());
        let stash_count = || {
            String::from_utf8_lossy(&git(&["stash", "list"]).stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count()
        };
        let head = || String::from_utf8_lossy(&git(&["symbolic-ref", "--short", "HEAD"]).stdout).trim().to_string();
        let p = tmp.to_str().unwrap();

        // BRING: dirty tracked file follows to the other branch, stash empty
        std::fs::write(tmp.join("a.txt"), "dirty\n").unwrap();
        checkout(p, "other", None, Some(CarryChanges::Bring)).await.unwrap();
        assert_eq!(head(), "other");
        assert_eq!(std::fs::read_to_string(tmp.join("a.txt")).unwrap(), "dirty\n", "changes must follow a Bring carry");
        assert_eq!(stash_count(), 0, "Bring pops its own stash");

        // STASH: tracked edit + untracked file land on the stack, tree clean
        std::fs::write(tmp.join("a.txt"), "dirty2\n").unwrap();
        std::fs::write(tmp.join("new.txt"), "untracked\n").unwrap();
        checkout(p, "main", None, Some(CarryChanges::Stash)).await.unwrap();
        assert_eq!(head(), "main");
        assert_eq!(std::fs::read_to_string(tmp.join("a.txt")).unwrap(), "one\n", "Stash leaves the target branch clean");
        assert!(!tmp.join("new.txt").exists(), "untracked files are stashed too (-u)");
        assert_eq!(stash_count(), 1, "Stash keeps the entry");
        // the entry round-trips: pop restores both files
        assert!(git(&["stash", "pop", "-q"]).status.success());
        assert_eq!(std::fs::read_to_string(tmp.join("a.txt")).unwrap(), "dirty2\n");
        assert_eq!(std::fs::read_to_string(tmp.join("new.txt")).unwrap(), "untracked\n");

        // REFUSED checkout: pop-back restores the worktree, nothing stashed
        checkout(p, "does-not-exist", None, Some(CarryChanges::Bring)).await.unwrap_err();
        assert_eq!(head(), "main", "refused checkout must not move HEAD");
        assert_eq!(std::fs::read_to_string(tmp.join("a.txt")).unwrap(), "dirty2\n", "refused checkout must restore the dirty file");
        assert_eq!(stash_count(), 0, "the undo-pop must drop its own stash");

        // BRING on a clean tree: no stash created, nothing popped
        assert!(git(&["checkout", "-q", "--", "."]).status.success()); // clean the tree (discard)
        checkout(p, "other", None, Some(CarryChanges::Bring)).await.unwrap();
        assert_eq!(head(), "other");
        assert_eq!(stash_count(), 0, "clean tree + Bring must not touch the stash");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Moving a tag repoints it WITHOUT flattening the annotation
    /// (`tag -f` would recreate it lightweight; update-ref keeps the object).
    #[tokio::test]
    async fn move_tag_repoints_and_keeps_annotation() {
        let tmp = std::env::temp_dir().join(format!("sirgit-movetag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&tmp)
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        assert!(git(&["config", "user.name", "T"]).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"]).status.success());
        std::fs::write(tmp.join("a.txt"), "a\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c1"]).status.success());
        assert!(git(&["tag", "-a", "v1", "-m", "release one"]).status.success());
        std::fs::write(tmp.join("b.txt"), "b\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c2"]).status.success());
        let c2 = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout).trim().to_string();

        move_tag(tmp.to_str().unwrap(), "v1", &c2).await.unwrap();

        let kind = String::from_utf8_lossy(&git(&["cat-file", "-t", "refs/tags/v1"]).stdout).trim().to_string();
        assert_eq!(kind, "tag", "annotated tag must stay annotated after a move");
        let peeled = String::from_utf8_lossy(&git(&["rev-parse", "v1^{commit}"]).stdout).trim().to_string();
        assert_eq!(peeled, c2, "tag must peel to the new target");
        let msg = String::from_utf8_lossy(
            &git(&["for-each-ref", "--format=%(contents)", "refs/tags/v1"]).stdout,
        )
        .trim()
        .to_string();
        assert_eq!(msg, "release one", "tag message must survive the move");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Orphan commit: no parents, empty tree, pinned under refs/sirgit/orphans/
    /// so `git log --all` lists it and read_refs shows no chip for it.
    #[tokio::test]
    async fn creates_dangling_orphan_visible_in_log_all() {
        let tmp = std::env::temp_dir().join(format!("sirgit-orphantest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&tmp)
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        assert!(git(&["config", "user.name", "T"]).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"]).status.success());
        let sha = create_orphan(tmp.to_str().unwrap(), "orphan test").await.unwrap();
        assert_eq!(sha.len(), 40);

        // no parents, empty tree
        let cat = git(&["cat-file", "-p", &sha]);
        assert!(cat.status.success());
        let text = String::from_utf8_lossy(&cat.stdout).to_string();
        assert!(text.starts_with("tree "));
        assert!(!text.contains("parent"));

        // visible via --all (the pinning ref) and absent from branch/tag refs
        let log = git(&["log", "--all", "--format=%s"]);
        assert!(String::from_utf8_lossy(&log.stdout).contains("orphan test"));
        let refs = git(&["for-each-ref", "--format=%(refname)"]);
        let refnames = String::from_utf8_lossy(&refs.stdout).to_string();
        assert!(refnames.contains("refs/sirgit/orphans/"));
        assert!(!refnames.contains("refs/heads/"));
        assert!(!refnames.contains("refs/tags/"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// rebase_start replays the current branch onto the target branch tip.
    #[tokio::test]
    async fn rebases_current_branch_onto_target() {
        let tmp = std::env::temp_dir().join(format!("sirgit-rebasertest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&tmp)
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        assert!(git(&["config", "user.name", "T"]).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"]).status.success());
        std::fs::write(tmp.join("a.txt"), "one\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c1"]).status.success());

        // diverge: feat gets c2, main gets c3
        assert!(git(&["checkout", "-q", "-b", "feat"]).status.success());
        std::fs::write(tmp.join("b.txt"), "feat\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c2"]).status.success());
        assert!(git(&["checkout", "-q", "main"]).status.success());
        std::fs::write(tmp.join("c.txt"), "main\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c3"]).status.success());

        // rebase feat (current) onto main: c2 replays on top of c3
        assert!(git(&["checkout", "-q", "feat"]).status.success());
        rebase_start(tmp.to_str().unwrap(), "main").await.unwrap();
        let log = git(&["log", "--format=%s"]);
        assert_eq!(
            String::from_utf8_lossy(&log.stdout).trim(),
            "c2\nc3\nc1",
            "c3 must sit between c2 and c1 after the rebase"
        );
        // merge-base is now c3 — fully replayed, no leftover divergence
        let mb = git(&["merge-base", "feat", "main"]);
        let c3 = String::from_utf8_lossy(&git(&["rev-parse", "main"]).stdout).trim().to_string();
        assert_eq!(String::from_utf8_lossy(&mb.stdout).trim(), c3);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Non-current branch squash: one new commit (tip's tree) on the base,
    /// gathered message baked in; the worktree and the base stay untouched.
    #[tokio::test]
    async fn squash_replaces_segment_with_one_commit() {
        let tmp = std::env::temp_dir().join(format!("sirgit-squashtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&tmp)
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        assert!(git(&["config", "user.name", "T"]).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"]).status.success());
        std::fs::write(tmp.join("a.txt"), "one\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c1"]).status.success());
        let c1 = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout).trim().to_string();

        assert!(git(&["checkout", "-q", "-b", "feat"]).status.success());
        std::fs::write(tmp.join("b.txt"), "two\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c2"]).status.success());
        std::fs::write(tmp.join("c.txt"), "three\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c3"]).status.success());
        let c3 = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout).trim().to_string();

        // squash feat's segment onto c1 while main is checked out
        assert!(git(&["checkout", "-q", "main"]).status.success());
        let res = squash(tmp.to_str().unwrap(), "feat", &c1).await.unwrap();
        assert!(res.is_none(), "non-current branch squashes via ref surgery, no prefill");

        let new_tip = String::from_utf8_lossy(&git(&["rev-parse", "feat"]).stdout).trim().to_string();
        assert_ne!(new_tip, c3, "feat must point at the new squashed commit");
        // single parent = the base; tree preserved from the old tip
        let cat_out = git(&["cat-file", "-p", &new_tip]);
        let cat = String::from_utf8_lossy(&cat_out.stdout);
        assert!(cat.lines().any(|l| l == &format!("parent {c1}")));
        assert_eq!(
            String::from_utf8_lossy(&git(&["rev-parse", &format!("{new_tip}^{{tree}}")]).stdout).trim(),
            String::from_utf8_lossy(&git(&["rev-parse", &format!("{c3}^{{tree}}")]).stdout).trim(),
        );
        // message: 2 commits gathered
        assert!(cat.contains("Squash 2 commits from feat"));
        // main untouched, worktree files from main only
        assert_eq!(
            String::from_utf8_lossy(&git(&["rev-parse", "main"]).stdout).trim(),
            c1
        );
        assert!(!tmp.join("b.txt").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Current branch squash: soft reset to the base + (title, body) returned.
    #[tokio::test]
    async fn squash_soft_resets_and_returns_message() {
        let tmp = std::env::temp_dir().join(format!("sirgit-squashsoft-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&tmp)
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        assert!(git(&["config", "user.name", "T"]).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"]).status.success());
        std::fs::write(tmp.join("a.txt"), "one\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c1"]).status.success());
        let c1 = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout).trim().to_string();
        std::fs::write(tmp.join("a.txt"), "one\ntwo\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c2"]).status.success());

        let (title, body) = squash(tmp.to_str().unwrap(), "main", &c1).await.unwrap().unwrap();
        assert_eq!(title, "c2");
        assert!(body.is_empty(), "c2 has no commit body: {body:?}");
        assert_eq!(
            String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout).trim(),
            c1,
            "soft reset moved HEAD back to the base"
        );
        // c2's change is staged for the one new commit
        let diff_out = git(&["diff", "--cached", "--name-only"]);
        let diff = String::from_utf8_lossy(&diff_out.stdout);
        assert!(diff.contains("a.txt"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Revert: a new commit undoing the target's changes; content restored.
    #[tokio::test]
    async fn revert_creates_undo_commit() {
        let tmp = std::env::temp_dir().join(format!("sirgit-reverttest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&tmp)
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        assert!(git(&["config", "user.name", "T"]).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"]).status.success());
        std::fs::write(tmp.join("a.txt"), "one\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c1"]).status.success());
        std::fs::write(tmp.join("a.txt"), "one\ntwo\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c2"]).status.success());
        let c2 = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout).trim().to_string();

        revert_commit(tmp.to_str().unwrap(), &c2).await.unwrap();
        assert_eq!(std::fs::read_to_string(tmp.join("a.txt")).unwrap(), "one\n");
        let count = String::from_utf8_lossy(&git(&["rev-list", "--count", "HEAD"]).stdout).trim().to_string();
        assert_eq!(count, "3", "revert appended an undo commit");
        let log_out = git(&["log", "-1", "--format=%s"]);
        let last = String::from_utf8_lossy(&log_out.stdout);
        assert!(last.contains("Revert"), "auto revert message, got: {last}");

        let _ = std::fs::remove_dir_all(&tmp);
    }
    #[tokio::test]
    async fn cherry_pick_replays_commit_on_head() {
        let tmp = std::env::temp_dir().join(format!("sirgit-cherrytest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&tmp)
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        assert!(git(&["config", "user.name", "T"]).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"]).status.success());
        std::fs::write(tmp.join("a.txt"), "one\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c1"]).status.success());
        // side branch with one commit
        assert!(git(&["checkout", "-q", "-b", "feat"]).status.success());
        std::fs::write(tmp.join("b.txt"), "side\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "side work"]).status.success());
        let feat = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout).trim().to_string();
        assert!(git(&["checkout", "-q", "main"]).status.success());

        cherry_pick(tmp.to_str().unwrap(), &feat).await.unwrap();
        assert_eq!(std::fs::read_to_string(tmp.join("b.txt")).unwrap(), "side\n");
        let subjects = String::from_utf8_lossy(&git(&["log", "--format=%s"]).stdout).to_string();
        assert!(subjects.contains("side work"), "picked commit replayed on main: {subjects}");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
