use std::path::Path;

use serde::{Deserialize, Serialize};

use super::proc::{run_git, GitKind};
use super::repo::resolve_repo_paths;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    /// 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' — index side; '.' means unchanged there
    pub index_status: String,
    /// same alphabet — worktree side
    pub worktree_status: String,
    pub untracked: bool,
    pub conflict: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<i64>,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub head_oid: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub files: Vec<FileEntry>,
    pub in_merge: bool,
    pub in_rebase: bool,
    pub in_cherry: bool,
    pub in_revert: bool,
}

#[derive(Debug, Default, Clone)]
pub struct NumStat {
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub binary: bool,
}

/// Parse `git diff --numstat -z` output. Keyed by path; renames keyed by new path.
pub fn parse_numstat(stdout: &str) -> std::collections::HashMap<String, NumStat> {
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
        // rename records carry origPath in a following NUL token (no tabs)
        let next_is_orig = tokens.get(i + 1).map(|t| !t.contains('\t') && !t.is_empty()).unwrap_or(false);
        let entry = NumStat {
            additions: if add == "-" { None } else { add.parse().ok() },
            deletions: if del == "-" { None } else { del.parse().ok() },
            binary: add == "-",
        };
        if !path.is_empty() {
            map.insert(path, entry);
        }
        i += if next_is_orig { 2 } else { 1 };
    }
    map
}

fn classify_state(x: char, y: char, untracked: bool) -> (bool, bool, bool) {
    // (staged, worktree, conflict)
    if untracked {
        return (false, true, false);
    }
    let conflict = x == 'U' || y == 'U' || x == 'A' && y == 'A' || x == 'D' && y == 'D';
    let staged = x != '.';
    let worktree = y != '.' && y != '?';
    (staged, worktree, conflict)
}

/// Parse `git status --porcelain=v2 --branch -z` output.
pub fn parse_porcelain_v2(stdout: &str) -> (Vec<FileEntry>, Option<String>, Option<String>, Option<String>, i64, i64) {
    let mut files = Vec::new();
    let mut head_oid = None;
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;

    let tokens: Vec<&str> = stdout.split('\0').collect();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        if tok.is_empty() {
            i += 1;
            continue;
        }
        if let Some(rest) = tok.strip_prefix("# ") {
            if let Some(v) = rest.strip_prefix("branch.oid ") {
                head_oid = Some(v.trim().to_string());
            } else if let Some(v) = rest.strip_prefix("branch.head ") {
                let v = v.trim();
                branch = if v == "(detached)" { None } else { Some(v.to_string()) };
            } else if let Some(v) = rest.strip_prefix("branch.upstream ") {
                upstream = Some(v.trim().to_string());
            } else if let Some(v) = rest.strip_prefix("branch.ab ") {
                let v = v.trim();
                let mut it = v.split_whitespace();
                ahead = it.next().unwrap_or("+0").trim_start_matches('+').parse().unwrap_or(0);
                behind = it.next().unwrap_or("-0").trim_start_matches('-').parse().unwrap_or(0);
            }
            i += 1;
            continue;
        }
        if let Some(rest) = tok.strip_prefix("2 ") {
            // rename record: XY sub mH mI mW hH hI Xscore path, origPath in the next NUL token
            let mut parts = rest.splitn(9, ' ');
            let xy = parts.next().unwrap_or("....").to_string();
            let _sub = parts.next();
            for _ in 0..5 {
                parts.next(); // mH mI mW hH hI
            }
            let _xscore = parts.next();
            let path = parts.next().unwrap_or("").to_string();
            let x = xy.chars().next().unwrap_or('.');
            let y = xy.chars().nth(1).unwrap_or('.');
            let orig_path = tokens.get(i + 1).copied().unwrap_or("");
            let (_, _, conflict) = classify_state(x, y, false);
            files.push(FileEntry {
                path,
                orig_path: Some(orig_path.to_string()).filter(|s| !s.is_empty()),
                index_status: x.to_string(),
                worktree_status: y.to_string(),
                untracked: false,
                conflict,
                additions: None,
                deletions: None,
                binary: false,
            });
            i += if orig_path.is_empty() { 1 } else { 2 };
            continue;
        }
        if let Some(rest) = tok.strip_prefix("1 ") {
            // ordinary record: XY sub mH mI mW hH hI path
            let mut parts = rest.splitn(8, ' ');
            let xy = parts.next().unwrap_or("....").to_string();
            let _sub = parts.next();
            for _ in 0..5 {
                parts.next(); // mH mI mW hH hI
            }
            let path = parts.next().unwrap_or("").to_string();
            let x = xy.chars().next().unwrap_or('.');
            let y = xy.chars().nth(1).unwrap_or('.');
            let (_, _, conflict) = classify_state(x, y, false);
            files.push(FileEntry {
                path,
                orig_path: None,
                index_status: x.to_string(),
                worktree_status: y.to_string(),
                untracked: false,
                conflict,
                additions: None,
                deletions: None,
                binary: false,
            });
            i += 1;
            continue;
        }
        if let Some(rest) = tok.strip_prefix("u ") {
            // unmerged record: XY sub m1 m2 m3 mW h1 h2 h3 path
            let mut parts = rest.splitn(10, ' ');
            let xy = parts.next().unwrap_or("...").to_string();
            let _sub = parts.next();
            for _ in 0..7 {
                parts.next(); // m1 m2 m3 mW h1 h2 h3
            }
            let path = parts.next().unwrap_or("").to_string();
            let x = xy.chars().next().unwrap_or('.');
            let y = xy.chars().nth(1).unwrap_or('.');
            files.push(FileEntry {
                path,
                orig_path: None,
                index_status: x.to_string(),
                worktree_status: y.to_string(),
                untracked: false,
                conflict: true,
                additions: None,
                deletions: None,
                binary: false,
            });
            i += 1;
            continue;
        }
        if let Some(rest) = tok.strip_prefix("? ") {
            files.push(FileEntry {
                path: rest.to_string(),
                orig_path: None,
                index_status: ".".into(),
                worktree_status: "?".into(),
                untracked: true,
                conflict: false,
                additions: None,
                deletions: None,
                binary: false,
            });
            i += 1;
            continue;
        }
        // "! " ignored paths and anything else
        i += 1;
    }

    (files, head_oid, branch, upstream, ahead, behind)
}

fn gitdir_flag(git_dir: &Path, name: &str) -> bool {
    git_dir.join(name).exists()
}

/// Full working-tree + index status for a repo. Read-only spawns.
pub async fn read_status(path: &str) -> Result<StatusSnapshot, super::errors::GitError> {
    let (worktree, git_dir) = resolve_repo_paths(path).map_err(|e| {
        super::errors::GitError::new("not-a-repository", e, "resolve-repo", "")
    })?;

    let args = vec![
        "status".into(),
        "--porcelain=v2".into(),
        "--branch".into(),
        "-z".into(),
        "--untracked-files=all".into(),
    ];
    let out = run_git(&worktree, &args, GitKind::ReadOnly).await?;
    let (mut files, head_oid, branch, upstream, ahead, behind) = parse_porcelain_v2(&out.stdout);

    // join numstats: staged (index vs HEAD) and worktree (worktree vs index)
    let cached = run_git(&worktree, &["diff".into(), "--cached".into(), "--numstat".into(), "-z".into()], GitKind::ReadOnly).await;
    let worktree_numstat = run_git(&worktree, &["diff".into(), "--numstat".into(), "-z".into()], GitKind::ReadOnly).await;
    let cached_map = cached.map(|o| parse_numstat(&o.stdout)).unwrap_or_default();
    let wt_map = worktree_numstat.map(|o| parse_numstat(&o.stdout)).unwrap_or_default();

    for f in files.iter_mut() {
        if f.index_status != "." && f.index_status != "?" {
            if let Some(n) = cached_map.get(&f.path) {
                f.additions = n.additions;
                f.deletions = n.deletions;
                f.binary = n.binary;
            }
        }
        if f.worktree_status != "." && f.worktree_status != "?" && !f.untracked {
            if let Some(n) = wt_map.get(&f.path) {
                f.additions = n.additions;
                f.deletions = n.deletions;
                f.binary = f.binary || n.binary;
            }
        }
    }
    // untracked files never appear in `git diff --numstat` (they are in
    // neither index nor any tree) — count their lines directly so the row
    // still carries the +N annotation. Capped at 1 MiB; a NUL byte = binary.
    for f in files.iter_mut().filter(|f| f.untracked) {
        let p = worktree.join(&f.path);
        if let Ok(meta) = std::fs::metadata(&p) {
            if meta.len() > 1_048_576 {
                continue;
            }
            if let Ok(bytes) = std::fs::read(&p) {
                if bytes.contains(&0) {
                    f.binary = true;
                    continue;
                }
                let mut lines: i64 = 0;
                let mut ends_nl = true;
                for b in bytes.iter() {
                    if *b == b'\n' {
                        lines += 1;
                        ends_nl = true;
                    } else {
                        ends_nl = false;
                    }
                }
                if !bytes.is_empty() && !ends_nl {
                    lines += 1;
                }
                f.additions = Some(lines);
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(StatusSnapshot {
        head_oid,
        branch,
        upstream,
        ahead,
        behind,
        files,
        in_merge: gitdir_flag(&git_dir, "MERGE_HEAD"),
        in_rebase: gitdir_flag(&git_dir, "rebase-merge") || gitdir_flag(&git_dir, "rebase-apply"),
        in_cherry: gitdir_flag(&git_dir, "CHERRY_PICK_HEAD"),
        in_revert: gitdir_flag(&git_dir, "REVERT_HEAD"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2_records() {
        let input = "# branch.oid abc123\x00# branch.head main\x00# branch.upstream origin/main\x00# branch.ab +2 -1\x001 M. N... 100644 100644 100644 aaaa bbbb f1.txt\x001 .M N... 100644 100644 100644 aaaa bbbb f2.txt\x002 RM N... 100644 100644 100644 aaaa bbbb R100 new.txt\x00old.txt\x00? untracked.txt\x00u UU N... 111 222 333 wt sha1 sha2 sha3 conf.txt\x00";
        let (files, oid, branch, upstream, ahead, behind) = parse_porcelain_v2(input);
        assert_eq!(oid.as_deref(), Some("abc123"));
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(upstream.as_deref(), Some("origin/main"));
        assert_eq!(ahead, 2);
        assert_eq!(behind, 1);
        assert_eq!(files.len(), 5);

        let f1 = files.iter().find(|f| f.path == "f1.txt").unwrap();
        assert!(f1.index_status == "M" && f1.worktree_status == ".");
        let f2 = files.iter().find(|f| f.path == "f2.txt").unwrap();
        assert!(f2.index_status == "." && f2.worktree_status == "M");
        let ren = files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(ren.orig_path.as_deref(), Some("old.txt"));
        assert!(ren.index_status == "R" && ren.worktree_status == "M");
        let untracked = files.iter().find(|f| f.path == "untracked.txt").unwrap();
        assert!(untracked.untracked);
        let conf = files.iter().find(|f| f.path == "conf.txt").unwrap();
        assert!(conf.conflict);
    }

    #[test]
    fn parses_numstat() {
        let input = "12\t3\tf1.txt\x00-\t-\timg.png\x005\t2\trenamed.txt\x00old.txt\x00";
        let m = parse_numstat(input);
        assert_eq!(m.get("f1.txt").unwrap().additions, Some(12));
        assert!(m.get("img.png").unwrap().binary);
        assert_eq!(m.get("renamed.txt").unwrap().deletions, Some(2));
    }

    #[tokio::test]
    async fn reads_status_of_dirty_repo() {
        let tmp = std::env::temp_dir().join(format!("sirgit-status-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() % 100000));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git").args(args).current_dir(&tmp)
                .env("GIT_AUTHOR_NAME", "T").env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "T").env("GIT_COMMITTER_EMAIL", "t@t")
                .output().unwrap()
        };
        assert!(git(&["init", "-q", "-b", "main"]).status.success());
        assert!(git(&["config", "user.name", "T"]).status.success());
        assert!(git(&["config", "user.email", "t@sirgit.test"]).status.success());
        std::fs::write(tmp.join("a.txt"), "hello\n").unwrap();
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-q", "-m", "c1"]).status.success());

        // dirty the worktree + add one staged file + one untracked
        std::fs::write(tmp.join("a.txt"), "hello\nworld\n").unwrap();
        std::fs::write(tmp.join("b.txt"), "staged\n").unwrap();
        assert!(git(&["add", "b.txt"]).status.success());
        std::fs::write(tmp.join("c.txt"), "untracked\n").unwrap();

        let st = read_status(tmp.to_str().unwrap()).await.unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        let a = st.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(a.worktree_status, "M");
        assert_eq!(a.additions, Some(1));
        let b = st.files.iter().find(|f| f.path == "b.txt").unwrap();
        assert_eq!(b.index_status, "A");
        let c = st.files.iter().find(|f| f.path == "c.txt").unwrap();
        assert!(c.untracked);
        assert_eq!(c.additions, Some(1), "untracked files count their lines as additions");
        assert!(!st.in_merge);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
