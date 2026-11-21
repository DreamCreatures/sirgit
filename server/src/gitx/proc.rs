use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use super::errors::{classify, GitError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitKind {
    /// Read-only op: no index writes (GIT_OPTIONAL_LOCKS=0), short timeout.
    ReadOnly,
    /// Local mutation: short timeout.
    Mutation,
    /// Network op (fetch/push/pull): long timeout, credential flow.
    Network,
    /// Clone: very long timeout.
    Clone,
}

impl GitKind {
    fn timeout(self) -> Duration {
        match self {
            GitKind::ReadOnly => Duration::from_secs(120),
            GitKind::Mutation => Duration::from_secs(120),
            GitKind::Network => Duration::from_secs(600),
            GitKind::Clone => Duration::from_secs(7200),
        }
    }
}

#[derive(Debug)]
pub struct GitOutput {
    pub stdout: String,
    #[allow(dead_code)] // part of the public output shape; callers may inspect
    pub stderr: String,
}

struct Spawned {
    child: tokio::process::Child,
    stdout_pipe: tokio::process::ChildStdout,
    stderr_pipe: tokio::process::ChildStderr,
}

fn base_env(cmd: &mut Command) {
    cmd.env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat");
}

fn spawn_cmd(repo_dir: &Path, args: &[String], command_str: &str, stdin: bool) -> Result<Spawned, GitError> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(repo_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    base_env(&mut cmd);
    cmd.stdin(if stdin { Stdio::piped() } else { Stdio::null() });

    let mut child = cmd
        .spawn()
        .map_err(|e| GitError::new("spawn-failed", e.to_string(), command_str.to_string(), ""))?;
    let stdout_pipe = child.stdout.take().expect("stdout piped");
    let stderr_pipe = child.stderr.take().expect("stderr piped");
    Ok(Spawned { child, stdout_pipe, stderr_pipe })
}

/// Run `git` in `repo_dir`, feeding optional stdin, with a hard timeout.
/// On timeout the child is killed (kill_on_drop) and a "timeout" error returned.
async fn run(
    repo_dir: &Path,
    args: &[String],
    stdin_data: Option<&str>,
    kind: GitKind,
    ok_codes: &[i32],
) -> Result<GitOutput, GitError> {
    let command_str = format!("git {}", args.join(" "));
    let mut spawned = spawn_cmd(repo_dir, args, &command_str, stdin_data.is_some())?;

    if let (Some(data), Some(mut pipe)) = (stdin_data, spawned.child.stdin.take()) {
        let _ = pipe.write_all(data.as_bytes()).await;
        let _ = pipe.shutdown().await;
        // pipe dropped here — closes stdin, git proceeds
    }

    let mut stdout_pipe = spawned.stdout_pipe;
    let mut stderr_pipe = spawned.stderr_pipe;
    let mut child = spawned.child;

    let work = async {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let (r1, r2, status) = tokio::join!(
            stdout_pipe.read_to_end(&mut stdout),
            stderr_pipe.read_to_end(&mut stderr),
            child.wait()
        );
        (r1, r2, status, stdout, stderr)
    };

    let finished = tokio::time::timeout(kind.timeout(), work).await;
    let (_, _, status, stdout, stderr) = match finished {
        Ok(v) => v,
        Err(_) => {
            return Err(GitError::new(
                "timeout",
                format!("git command timed out after {}s", kind.timeout().as_secs()),
                command_str,
                "",
            ))
        }
    };
    if let Err(e) = status {
        return Err(GitError::new("spawn-failed", e.to_string(), command_str, ""));
    }

    let stdout = String::from_utf8_lossy(&stdout).into_owned();
    let stderr = String::from_utf8_lossy(&stderr).into_owned();
    let code = status.unwrap_or_else(|_| std::process::ExitStatus::default()).code().unwrap_or(-1);

    if code == 0 || ok_codes.contains(&code) {
        Ok(GitOutput { stdout, stderr })
    } else {
        // merge conflicts and several other git failures print to stdout, not stderr
        let sniff = if stderr.trim().is_empty() { stdout.as_str() } else { stderr.as_str() };
        Err(classify(&command_str, &sniff))
    }
}

pub async fn run_git(repo_dir: &Path, args: &[String], kind: GitKind) -> Result<GitOutput, GitError> {
    run(repo_dir, args, None, kind, &[]).await
}

/// `git diff --no-index` (the only form that sees untracked files) exits 1
/// when the compared paths differ — that is success for us.
pub async fn run_git_diff_no_index(repo_dir: &Path, args: &[String]) -> Result<GitOutput, GitError> {
    run(repo_dir, args, None, GitKind::ReadOnly, &[1]).await
}

pub async fn run_git_with_stdin(
    repo_dir: &Path,
    args: &[String],
    stdin_data: &str,
    kind: GitKind,
) -> Result<GitOutput, GitError> {
    run(repo_dir, args, Some(stdin_data), kind, &[]).await
}
