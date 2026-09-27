//! Merge attribution: for lines a merge adds relative to its first parent, find the side-branch
//! commit that wrote them with `git blame --incremental <P1>..<M>` limited to the added ranges.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use anyhow::{Context, bail};
use bstr::{BString, ByteSlice};
use gix::ObjectId;

use crate::tracker::Hunk;

/// Who wrote a run of added lines. `None` origin = older than the side branch (blame boundary).
#[derive(Clone, Debug, PartialEq)]
pub struct BlameRun {
    /// 0-based line index in the merged file.
    pub start: u32,
    pub len: u32,
    pub origin: Option<BlameOrigin>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BlameOrigin {
    pub sha: ObjectId,
    pub name: BString,
    pub email: BString,
    pub time: i64,
}

/// Blame the inserted ranges of `hunks` in `path` at `merge`, limited to `first_parent..merge`.
pub fn blame_added(
    git_dir: &Path,
    merge: ObjectId,
    first_parent: ObjectId,
    path: &[u8],
    hunks: &[Hunk],
) -> anyhow::Result<Vec<BlameRun>> {
    let mut cmd = Command::new("git");
    // --root: a side branch's root commit (unrelated history, subtree merges) is a real origin,
    // not a boundary.
    cmd.arg("--git-dir")
        .arg(git_dir)
        .args(["blame", "--incremental", "-w", "--root"]);
    let mut any = false;
    for h in hunks {
        if h.a1 > h.a0 {
            cmd.arg("-L").arg(format!("{},{}", h.a0 + 1, h.a1));
            any = true;
        }
    }
    if !any {
        return Ok(Vec::new());
    }
    let path_os: &std::ffi::OsStr = &path.to_os_str_lossy();
    cmd.arg(format!("{first_parent}..{merge}"))
        .arg("--")
        .arg(path_os);
    let out = cmd.output().context("running git blame")?;
    if !out.status.success() {
        bail!(
            "git blame {}: {}",
            path.as_bstr(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    parse_incremental(&out.stdout)
}

#[derive(Default)]
struct Header {
    name: BString,
    email: BString,
    time: i64,
    boundary: bool,
}

/// Parse `git blame --incremental` output into runs (sorted by line).
pub fn parse_incremental(out: &[u8]) -> anyhow::Result<Vec<BlameRun>> {
    let mut commits: HashMap<ObjectId, Header> = HashMap::new();
    let mut runs = Vec::new();
    let mut cur: Option<(ObjectId, u32, u32)> = None;
    for line in out.lines() {
        if let Some((sha, start, len)) = cur {
            // header lines until "filename"
            let h = commits.entry(sha).or_default();
            if let Some(v) = line.strip_prefix(b"author ") {
                h.name = v.into();
            } else if let Some(v) = line.strip_prefix(b"author-mail ") {
                h.email = v
                    .trim_start_with(|c| c == '<')
                    .trim_end_with(|c| c == '>')
                    .into();
            } else if let Some(v) = line.strip_prefix(b"author-time ") {
                h.time = v.to_str_lossy().trim().parse().unwrap_or(0);
            } else if line == b"boundary" {
                h.boundary = true;
            } else if line.starts_with(b"filename ") {
                let h = &commits[&sha];
                runs.push(BlameRun {
                    start,
                    len,
                    origin: (!h.boundary).then(|| BlameOrigin {
                        sha,
                        name: h.name.clone(),
                        email: h.email.clone(),
                        time: h.time,
                    }),
                });
                cur = None;
            }
            continue;
        }
        let mut parts = line.split_str(" ");
        let (Some(sha), Some(_orig), Some(fin), Some(n)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let sha = ObjectId::from_hex(sha).map_err(|e| anyhow::anyhow!("blame sha: {e}"))?;
        let fin: u32 = fin.to_str_lossy().parse().context("blame line")?;
        let n: u32 = n.to_str_lossy().parse().context("blame count")?;
        cur = Some((sha, fin.saturating_sub(1), n));
    }
    runs.sort_by_key(|r| r.start);
    Ok(runs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_incremental_output() {
        let out = b"1111111111111111111111111111111111111111 1 3 2
author Bob B
author-mail <bob@example.com>
author-time 1700000000
author-tz +0000
summary feature
filename app/f.rs
2222222222222222222222222222222222222222 5 1 1
author Mo
author-mail <mo@example.com>
author-time 1700000100
boundary
filename app/f.rs
1111111111111111111111111111111111111111 9 9 1
filename app/f.rs
";
        let runs = parse_incremental(out).unwrap();
        assert_eq!(runs.len(), 3);
        assert_eq!((runs[0].start, runs[0].len), (0, 1));
        assert!(
            runs[0].origin.is_none(),
            "boundary lines have no side-branch origin"
        );
        assert_eq!((runs[1].start, runs[1].len), (2, 2));
        let o = runs[1].origin.as_ref().unwrap();
        assert_eq!(
            (o.name.as_bstr(), o.email.as_bstr(), o.time),
            (
                b"Bob B".as_bstr(),
                b"bob@example.com".as_bstr(),
                1_700_000_000
            )
        );
        assert_eq!(runs[2].start, 8);
        assert!(
            runs[2].origin.is_some(),
            "headers are reused for repeated commits"
        );
    }
}
