use serde::Serialize;

/// Typed git error with a stable machine code the frontend can branch on.
/// Fresh taxonomy (no ungit code copied) covering the same user-facing situations.
#[derive(Debug, Clone, Serialize)]
pub struct GitError {
    pub code: String,
    pub message: String,
    pub command: String,
    pub stderr: String,
}

impl GitError {
    pub fn new(code: &str, message: impl Into<String>, command: impl Into<String>, stderr: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            command: command.into(),
            stderr: stderr.into(),
        }
    }

    pub fn io(e: std::io::Error) -> Self {
        Self::new("io-error", e.to_string(), "filesystem", "")
    }
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} [{}] — {}", self.code, self.command, self.message)
    }
}

impl std::error::Error for GitError {}

/// Classify a failed git invocation by sniffing its stderr.
pub fn classify(command: &str, stderr: &str) -> GitError {
    let s = stderr;
    let code = if s.contains("not a git repository") || s.contains("not a git command") {
        "not-a-repository"
    } else if s.contains("detected dubious ownership") {
        "dubious-ownership"
    } else if s.contains("does not have any commits yet") || s.contains("unknown revision or path not in the working tree") && s.contains("HEAD") {
        "no-commits"
    } else if s.contains("ambiguous argument") || s.contains("bad revision") || s.contains("Invalid object name") {
        "bad-revision"
    } else if s.contains("CONFLICT") || s.contains("Automatic merge failed") || s.contains("could not apply") {
        "merge-failed"
    } else if s.contains("non-fast-forward") || s.contains("rejected because the remote contains work that you do not have locally") {
        "non-fast-forward"
    } else if s.contains("Could not resolve host")
        || s.contains("Connection timed out")
        || s.contains("Failed to connect")
        || s.contains("connection attempt failed")
        || s.contains("network unreachable")
    {
        "offline"
    } else if s.contains("Authentication failed")
        || s.contains("Invalid username or password")
        || s.contains("403")
        || s.contains("Permission denied (publickey")
        || s.contains("could not read Username")
    {
        "authentication-failed"
    } else if s.contains("Your local changes to the following files would be overwritten")
        || s.contains("Please commit your changes or stash them")
    {
        "local-changes-would-be-overwritten"
    } else if s.contains("nothing to commit")
    {
        "nothing-to-commit"
    } else if s.contains("Please tell me who you are") {
        "missing-identity"
    } else if s.contains("fatal:") && s.contains("Terminal prompts disabled") {
        "terminal-prompts-disabled"
    } else if s.contains("already exists") {
        "already-exists"
    } else if s.contains("not found") && s.contains("upstream") {
        "no-upstream"
    } else if s.contains("cannot delete branch") && s.contains("checked out") {
        "branch-checked-out"
    } else if s.contains("would be overwritten by checkout") {
        "checkout-conflict"
    } else if s.contains("You are in the middle of a merge") || s.contains("You have not concluded your merge") {
        "merge-in-progress"
    } else if s.contains("You are in the middle of a rebase") || s.contains("cannot rebase") && s.contains("rebase") {
        "rebase-in-progress"
    } else if s.contains("Not possible to fast-forward") || s.contains("diverging branches") {
        // merge --ff-only on a diverged branch (pull / fast-forward checkout)
        "not-fast-forward"
    } else if s.contains("timed out") {
        "timeout"
    } else {
        "unknown"
    };

    let message = first_meaningful_line(s).unwrap_or_else(|| format!("git command failed ({})", code));
    GitError::new(code, message, command, s.to_string())
}

fn first_meaningful_line(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_common_failures() {
        let e = classify("git fetch", "fatal: Could not resolve host: github.com");
        assert_eq!(e.code, "offline");

        let e = classify("git commit", "fatal: nothing to commit, working tree clean");
        assert_eq!(e.code, "nothing-to-commit");

        let e = classify("git push", "! [rejected]        main -> main (non-fast-forward)");
        assert_eq!(e.code, "non-fast-forward");

        let e = classify("git merge", "Auto-merging f.txt\nCONFLICT (content): Merge conflict in f.txt\nAutomatic merge failed; fix conflicts and then commit the result.");
        assert_eq!(e.code, "merge-failed");

        let e = classify("git status", "fatal: not a git repository (or any of the parent directories): .git");
        assert_eq!(e.code, "not-a-repository");
    }
}
