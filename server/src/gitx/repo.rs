use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepoKind {
    NoSuchPath,
    Uninited,
    Repo,
    Bare,
}

#[derive(Debug, Serialize, Clone)]
pub struct QuickStatus {
    #[serde(rename = "type")]
    pub kind: RepoKind,
    #[serde(rename = "gitRootPath")]
    pub git_root_path: Option<String>,
    #[serde(rename = "gitDir")]
    pub git_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "subRepos")]
    pub sub_repos: Option<Vec<String>>,
}

fn is_git_repo(path: &Path) -> bool {
    path.join(".git").exists()
}

/// Expand a leading `~` to the user's home directory ("~/x" → "/home/u/x").
/// The home page passes typed paths through verbatim; without this a `~/x`
/// submission created a literal `~` directory under the server's cwd.
pub fn expand_home(p: &str) -> String {
    if p == "~" {
        return dirs::home_dir()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.to_string());
    }
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    p.to_string()
}

/// Immediate git-repo children of a directory, as ABSOLUTE paths (the home
/// page imports them verbatim into its repository list).
fn find_sub_repos(path: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(path) else {
        return found;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() && is_git_repo(&p) {
            found.push(p.to_string_lossy().into_owned());
        }
    }
    found.sort();
    found
}

/// Classify a filesystem path the same way the frontend needs:
/// missing dir / plain dir / repo / bare repo (+ immediate sub-repos for the "choose a repo" view).
pub fn quickstatus(path: &str) -> QuickStatus {
    let p = PathBuf::from(expand_home(path));
    if !p.exists() {
        return QuickStatus { kind: RepoKind::NoSuchPath, git_root_path: None, git_dir: None, sub_repos: None };
    }
    if is_git_repo(&p) {
        // .git may be a directory (normal) or a file (linked worktree/submodule)
        let git_meta = p.join(".git");
        let git_dir = if git_meta.is_dir() {
            Some(git_meta.to_string_lossy().into_owned())
        } else {
            // parse "gitdir: <path>"
            std::fs::read_to_string(&git_meta).ok().and_then(|s| {
                s.trim().strip_prefix("gitdir:").map(|d| d.trim().to_string())
            })
        };
        let bare = git_dir.as_deref().map(is_bare_gitdir).unwrap_or(false);
        if bare {
            QuickStatus { kind: RepoKind::Bare, git_root_path: Some(p.to_string_lossy().into_owned()), git_dir, sub_repos: None }
        } else {
            QuickStatus {
                kind: RepoKind::Repo,
                git_root_path: Some(p.to_string_lossy().into_owned()),
                git_dir,
                sub_repos: Some(find_sub_repos(&p)),
            }
        }
    } else if p.is_dir() {
        // a SUBFOLDER of a repo used to classify as uninited → the home page
        // offered "Initialize repository?" and created a NESTED repo. Walk up
        // to the enclosing .git instead: the folder IS part of that repo.
        let mut cur: &Path = &p;
        while let Some(parent) = cur.parent() {
            if is_git_repo(parent) {
                return QuickStatus {
                    kind: RepoKind::Repo,
                    git_root_path: Some(parent.to_string_lossy().into_owned()),
                    git_dir: None,
                    sub_repos: Some(find_sub_repos(&p)),
                };
            }
            cur = parent;
        }
        let sub = find_sub_repos(&p);
        QuickStatus { kind: RepoKind::Uninited, git_root_path: None, git_dir: None, sub_repos: Some(sub) }
    } else {
        QuickStatus { kind: RepoKind::NoSuchPath, git_root_path: None, git_dir: None, sub_repos: None }
    }
}

fn is_bare_gitdir(git_dir: &str) -> bool {
    let config = std::fs::read_to_string(Path::new(git_dir).join("config")).unwrap_or_default();
    config.contains("bare = true") || config.contains("bare=true")
}

/// Resolve the working-tree root for git spawns and the git-dir path for watching.
/// Returns (worktree_root, git_dir). For normal repos both live under the same path.
pub fn resolve_repo_paths(path: &str) -> Result<(PathBuf, PathBuf), String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(format!("path does not exist: {}", path));
    }
    let dot_git = p.join(".git");
    if dot_git.is_dir() {
        Ok((p.clone(), dot_git))
    } else if dot_git.is_file() {
        let content = std::fs::read_to_string(&dot_git).unwrap_or_default();
        let gitdir = content
            .trim()
            .strip_prefix("gitdir:")
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let git_path = if Path::new(&gitdir).is_absolute() {
            PathBuf::from(gitdir)
        } else {
            p.join(gitdir)
        };
        Ok((p, git_path))
    } else {
        Err(format!("not a git repository: {}", path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_paths() {
        let tmp = std::env::temp_dir().join(format!("sirgit-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("plain")).unwrap();
        let qs = quickstatus(tmp.join("plain").to_str().unwrap());
        assert_eq!(qs.kind, RepoKind::Uninited);

        let qs = quickstatus(tmp.join("does-not-exist").to_str().unwrap());
        assert_eq!(qs.kind, RepoKind::NoSuchPath);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
