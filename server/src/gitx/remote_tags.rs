//! Which tags exist on the remote — the truth behind the UI's pushed-tag
//! chips (`<remote-abbrev>/<tag>`, e.g. `ori/v0.1.1`).
//!
//! git keeps no remote-tracking refs for tags (refs/remotes/ covers branches
//! only), so "is this tag pushed?" cannot be answered from local refs alone.
//! The row heuristic the UI started with (a tag is pushed when its row also
//! carries a remote-branch chip) breaks as soon as the branch moves past the
//! tag: v0.1.0/v0.1.1 are on origin yet their rows carry no remote chip once
//! main advances. So we ask the remote directly — `git ls-remote --tags` —
//! after every network op (credentials are already resolved in those flows;
//! without stored credentials the call fails fast, GIT_TERMINAL_PROMPT=0,
//! and the previous cache stays) and persist `<remote>\t<tag>` lines in
//! `<gitdir>/sirgit/remote-tags` (the remote name is stored too — the UI's
//! pushed-tag prefix names the actual remote, origin is not a keyword).
//! read_refs merges them into the snapshot as `remoteTags` + which remote.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::proc::{run_git, GitKind};
use super::repo::resolve_repo_paths;

/// Cached remote tags plus the remote they were last fetched from.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RemoteTagCache {
    /// the remote the last successful ls-remote ran against
    pub remote: Option<String>,
    pub tags: Vec<String>,
}

/// Parse `git ls-remote --tags` output into sorted, deduped tag names.
/// Lines look like `<sha>\trefs/tags/<name>`; annotated tags add a peeled
/// `<sha>\trefs/tags/<name>^{}` line — the suffix is stripped and deduped.
pub fn parse_ls_remote_tags(stdout: &str) -> Vec<String> {
    let mut names = BTreeSet::new();
    for line in stdout.lines() {
        let Some((_sha, r)) = line.split_once('\t') else { continue };
        let Some(name) = r.strip_prefix("refs/tags/") else { continue };
        let name = name.strip_suffix("^{}").unwrap_or(name);
        if !name.is_empty() {
            names.insert(name.to_string());
        }
    }
    names.into_iter().collect()
}

fn cache_path(gitdir: &Path) -> PathBuf {
    gitdir.join("sirgit").join("remote-tags")
}

/// Cached remote tag names — empty until the first successful ls-remote.
/// Lines are `<remote>\t<tag>`; a tab-less line is a legacy plain-name entry
/// (counts as a tag with an unknown remote).
pub fn read_cached(gitdir: &Path) -> RemoteTagCache {
    let mut cache = RemoteTagCache::default();
    let Ok(content) = std::fs::read_to_string(cache_path(gitdir)) else { return cache };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match line.split_once('\t') {
            Some((remote, tag)) => {
                if cache.remote.is_none() {
                    cache.remote = Some(remote.to_string());
                }
                cache.tags.push(tag.to_string());
            }
            None => cache.tags.push(line.to_string()),
        }
    }
    cache
}

/// Ask `remote` which tags it has and cache the answer in the gitdir.
/// Best-effort: on failure (offline, no stored credentials) the previous
/// cache is kept untouched. Last remote wins in multi-remote repos.
pub async fn refresh(repo: &str, remote: &str) -> RemoteTagCache {
    let Ok((worktree, gitdir)) = resolve_repo_paths(repo) else {
        return RemoteTagCache::default();
    };
    let args = vec!["ls-remote".into(), "--tags".into(), remote.to_string()];
    // metadata-only call — cap it far below the network-op timeout so a hung
    // remote never delays the completing fetch/push by minutes
    let out = tokio::time::timeout(
        Duration::from_secs(15),
        run_git(&worktree, &args, GitKind::Network),
    )
    .await;
    let names = match out {
        Ok(Ok(o)) => parse_ls_remote_tags(&o.stdout),
        Ok(Err(e)) => {
            tracing::warn!("remote-tags refresh failed for {}: {} ({})", remote, e.message, e.stderr.trim());
            return read_cached(&gitdir);
        }
        Err(_) => {
            tracing::warn!("remote-tags refresh timed out for {}", remote);
            return read_cached(&gitdir);
        }
    };
    let path = cache_path(&gitdir);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body: String = names.iter().map(|n| format!("{}\t{}\n", remote, n)).collect();
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
    RemoteTagCache { remote: Some(remote.to_string()), tags: names }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_ls_remote_output() {
        // verbatim shape from `git ls-remote --tags origin` on a repo with
        // two annotated tags (each tag object + its peeled commit)
        let stdout = "\
9f9dcce5de5416a0820b614d568ce0dd1691ef1c\trefs/tags/v0.1.0\n\
4513f35302494e400784d46dad6ba50101c237e2\trefs/tags/v0.1.0^{}\n\
a4b4e2db48868027cbde46e8e1270f6a61820d11\trefs/tags/v0.1.1\n\
91d0ff30baf694ea07e98830e9220349d28908ca\trefs/tags/v0.1.1^{}\n";
        assert_eq!(parse_ls_remote_tags(stdout), vec!["v0.1.0", "v0.1.1"]);
    }

    #[test]
    fn parses_lightweight_tags_and_ignores_garbage() {
        let stdout = "\
0000000000000000000000000000000000000001\trefs/tags/light\n\
garbage line without a tab\n\
0000000000000000000000000000000000000002\trefs/heads/main\n\
0000000000000000000000000000000000000003\trefs/tags/weird^{}\n";
        assert_eq!(parse_ls_remote_tags(stdout), vec!["light", "weird"]);
        assert!(parse_ls_remote_tags("").is_empty());
    }

    #[test]
    fn cache_roundtrips() {
        let dir = std::env::temp_dir().join(format!("sirgit-rt-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_cached(&dir), RemoteTagCache::default(), "missing cache reads as empty");
        std::fs::create_dir_all(dir.join("sirgit")).unwrap();
        std::fs::write(dir.join("sirgit/remote-tags"), "origin\tv0.1.0\norigin\tv0.1.1\n").unwrap();
        assert_eq!(
            read_cached(&dir),
            RemoteTagCache { remote: Some("origin".into()), tags: vec!["v0.1.0".into(), "v0.1.1".into()] }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_plain_name_lines_still_count() {
        let dir = std::env::temp_dir().join(format!("sirgit-rt-legacy-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sirgit")).unwrap();
        std::fs::write(dir.join("sirgit/remote-tags"), "v0.1.0\n").unwrap();
        let cache = read_cached(&dir);
        assert_eq!(cache.tags, vec!["v0.1.0"]);
        assert_eq!(cache.remote, None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
