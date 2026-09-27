//! Oracle tests: extract the fixture repos and check the results against git itself.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;

use strata_engine::ExtractOptions;
use strata_store::pipeline::extract_source;
use strata_store::{Db, Filters, Layout, Source};

fn fixtures() -> &'static Path {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let out = std::env::temp_dir().join(format!("strata-fixtures-{}", std::process::id()));
        let st = Command::new("bash")
            .arg(root.join("make.sh"))
            .arg(&out)
            .output()
            .expect("run make.sh");
        assert!(
            st.status.success(),
            "make.sh failed: {}",
            String::from_utf8_lossy(&st.stderr)
        );
        out
    })
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

/// Per first-parent commit: (adds, dels) summed over text files, from `git log --numstat`.
fn git_numstat(repo: &Path, ws: bool) -> Vec<(String, u64, u64)> {
    let mut args = vec![
        "log",
        "--first-parent",
        "-M",
        "--diff-algorithm=histogram",
        "--numstat",
        "--format=@%H",
        "--reverse",
    ];
    if ws {
        args.push("-w");
    }
    // git counts a submodule gitlink as a one-line "Subproject commit <sha>" file; strata
    // counts submodules as 0 lines, so leave them out of the oracle.
    let gitlinks: std::collections::HashSet<String> =
        git(repo, &["log", "--all", "--raw", "--format="])
            .lines()
            .filter(|l| l.starts_with(':') && l.contains("160000"))
            .filter_map(|l| l.split('\t').next_back().map(str::to_string))
            .collect();
    let mut out: Vec<(String, u64, u64)> = Vec::new();
    for line in git(repo, &args).lines() {
        if let Some(sha) = line.strip_prefix('@') {
            out.push((sha.to_string(), 0, 0));
        } else if let [a, d, path] = line.splitn(3, '\t').collect::<Vec<_>>()[..] {
            if gitlinks.contains(path) {
                continue;
            }
            if let (Ok(a), Ok(d)) = (a.parse::<u64>(), d.parse::<u64>()) {
                let last = out.last_mut().unwrap();
                last.1 += a;
                last.2 += d;
            }
        }
    }
    out
}

fn extract(layout: &Layout, repo: &Path) -> String {
    let src = Source::parse(repo.to_str().unwrap()).unwrap();
    let opts = ExtractOptions {
        threads: 3,
        ..Default::default()
    };
    let meta = extract_source(
        layout,
        &src,
        &opts,
        false,
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .unwrap();
    meta.id
}

fn check_repo(name: &str) {
    let repo = fixtures().join(name);
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().to_path_buf());
    let id = extract(&layout, &repo);
    let db = Db::new(layout.clone()).unwrap();

    // 1. Per-step churn equals git's numstat (strict and -w).
    for ws in [false, true] {
        let expected = git_numstat(&repo, ws);
        let got: Vec<(String, u64, u64)> = db
            .with(&id, |c, s| {
                let (a, d) = if ws { ("adds_ws", "dels_ws") } else { ("adds", "dels") };
                let mut stmt = c.prepare(&format!(
                    "SELECT st.sha, coalesce(sum(c.{a}) FILTER (WHERE NOT c.is_binary), 0)::UBIGINT,
                            coalesce(sum(c.{d}) FILTER (WHERE NOT c.is_binary), 0)::UBIGINT
                     FROM {s}.steps st LEFT JOIN {s}.changes c USING (step) GROUP BY st.step, st.sha ORDER BY st.step"
                ))?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
            .unwrap();
        assert_eq!(got, expected, "{name}: numstat mismatch (ws={ws})");
    }

    // 2. Final state line counts equal the blobs at HEAD.
    let head_lines: HashMap<String, u32> = git(&repo, &["ls-tree", "-r", "HEAD"])
        .lines()
        .filter(|l| l.starts_with("100"))
        .map(|l| {
            let (meta, path) = l.split_once('\t').unwrap();
            let oid = meta.split_whitespace().nth(2).unwrap();
            let content = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["cat-file", "blob", oid])
                .output()
                .unwrap()
                .stdout;
            let lines = if content[..content.len().min(8000)].contains(&0) {
                0
            } else {
                strata_engine::diff::count_lines(&content)
            };
            (path.to_string(), lines)
        })
        .collect();
    let state: HashMap<String, u32> = db
        .with(&id, |c, s| {
            let last: u32 = c.query_row(&format!("SELECT max(step) FROM {s}.steps"), [], |r| r.get(0))?;
            let sql = format!(
                "SELECT p.path, st.lines FROM ({}) st JOIN {s}.paths p USING (path_id) WHERE p.category <> 8",
                state_sql_for_test(s, last)
            );
            let mut stmt = c.prepare(&sql)?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i32>(1)? as u32)))?;
            Ok(rows.collect::<Result<HashMap<_, _>, _>>()?)
        })
        .unwrap();
    assert_eq!(
        state, head_lines,
        "{name}: final state differs from HEAD tree"
    );

    // 3. Survival deltas net to the surviving line count; size (line_delta) agrees too.
    let (deltas, size): (i64, i64) = db
        .with(&id, |c, s| {
            Ok(c.query_row(
                &format!("SELECT (SELECT sum(delta) FROM {s}.origin_deltas)::BIGINT, (SELECT sum(line_delta) FROM {s}.changes)::BIGINT"),
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    let total: i64 = head_lines.values().map(|&v| i64::from(v)).sum();
    assert_eq!(
        deltas, total,
        "{name}: origin deltas don't net to surviving lines"
    );
    assert_eq!(size, total, "{name}: line_delta doesn't sum to repo size");

    // 4. Survival attribution: per file, lines per author email equal `git blame -w HEAD`
    //    (merged lines credited to their side-branch authors, not the merger).
    let ours: HashMap<(String, String), i64> = db
        .with(&id, |c, s| {
            let mut stmt = c.prepare(&format!(
                "SELECT p.path, lower(a.email), sum(o.delta)::BIGINT FROM {s}.origin_deltas o
                 JOIN {s}.paths p USING (path_id) JOIN {s}.authors a ON a.author_id = o.author_id
                 GROUP BY ALL HAVING sum(o.delta) <> 0"
            ))?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                    r.get::<_, i64>(2)?,
                ))
            })?;
            Ok(rows.collect::<Result<HashMap<_, _>, _>>()?)
        })
        .unwrap();
    let mut theirs: HashMap<(String, String), i64> = HashMap::new();
    for path in head_lines.iter().filter(|(_, n)| **n > 0).map(|(p, _)| p) {
        let out = git(
            &repo,
            &["blame", "-w", "--line-porcelain", "HEAD", "--", path],
        );
        for line in out.lines() {
            if let Some(mail) = line.strip_prefix("author-mail ") {
                let mail = mail
                    .trim_start_matches('<')
                    .trim_end_matches('>')
                    .to_lowercase();
                *theirs.entry((path.clone(), mail)).or_insert(0) += 1;
            }
        }
    }
    assert_eq!(
        ours, theirs,
        "{name}: surviving lines per author differ from git blame"
    );

    // 5. The query endpoints run.
    let f = Filters {
        exclude: vec![4, 5, 6, 7],
        ..Default::default()
    };
    db.summary(&id).unwrap();
    db.axis(&id).unwrap();
    db.paths(&id).unwrap();
    let bins = strata_store::Bins {
        axis: strata_store::Axis::Index,
        lo: 0.0,
        hi: 100.0,
        bins: 10,
    };
    db.bars(&id, &f, &bins).unwrap();
    for slice in [
        strata_store::Slice::Dir,
        strata_store::Slice::Lang,
        strata_store::Slice::Author,
        strata_store::Slice::Cohort,
    ] {
        for mode in [strata_store::AreaMode::Size, strata_store::AreaMode::Flow] {
            let q = strata_store::AreaQuery {
                slice,
                mode,
                depth: 1,
                top: 5,
                unit: "month".into(),
            };
            db.area(&id, &f, &bins, &q).unwrap();
        }
    }
    db.state(&id, 3, &f).unwrap();
    db.events(&id, -1, 5, &f).unwrap();
    db.compare(&id, 1, 4, &f).unwrap();
    db.step(&id, 2).unwrap();
    db.commits(&id, 0, 5, &f, 10).unwrap();
    db.search(&id, "merge", "message", 50).unwrap();
    db.search(&id, "alice", "author", 50).unwrap();
    db.search(&id, "src", "path", 50).unwrap();
    db.dirs(&id, "", &f).unwrap();
    db.authors(&id).unwrap();
}

fn state_sql_for_test(s: &str, step: u32) -> String {
    format!(
        "SELECT path_id, arg_max(lines_after, step * 8 + CASE WHEN kind IN (2, 4) THEN 1 ELSE 2 END) AS lines,
                arg_max(kind, step * 8 + CASE WHEN kind IN (2, 4) THEN 1 ELSE 2 END) AS kind
         FROM {s}.changes WHERE step <= {step} GROUP BY path_id HAVING kind NOT IN (2, 4)"
    )
}

#[test]
fn linear_matches_git() {
    check_repo("linear");
}

#[test]
fn kitchen_matches_git() {
    check_repo("kitchen");
}

#[test]
fn incremental_resume_matches_full() {
    let src_repo = fixtures().join("linear");
    let work = tempfile::tempdir().unwrap();
    let repo = work.path().join("linear");
    git(
        work.path(),
        &[
            "clone",
            "-q",
            src_repo.to_str().unwrap(),
            repo.to_str().unwrap(),
        ],
    );
    // Extract a prefix of history, then the rest incrementally.
    git(&repo, &["reset", "-q", "--hard", "HEAD~3"]);
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().to_path_buf());
    let id = extract(&layout, &repo);
    git(&repo, &["reset", "-q", "--hard", "origin/main"]);
    let id2 = extract(&layout, &repo);
    assert_eq!(id, id2);
    let meta = layout.read_meta(&id).unwrap();
    assert_eq!(meta.last_run["resumed"], true);
    assert_eq!(meta.last_run["steps_new"], 3);

    let full_home = tempfile::tempdir().unwrap();
    let full_layout = Layout::new(full_home.path().to_path_buf());
    let fid = extract(&full_layout, &repo);
    let dump = |layout: &Layout, id: &str| -> Vec<String> {
        Db::new(layout.clone())
            .unwrap()
            .with(id, |c, s| {
                let mut stmt = c.prepare(&format!(
                    "SELECT concat_ws(',', step, path_id, kind, adds, dels, lines_after, line_delta, mean_origin_time, top_author)
                     FROM {s}.changes ORDER BY step, path_id, kind"
                ))?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
            .unwrap()
    };
    assert_eq!(dump(&layout, &id), dump(&full_layout, &fid));
    let dump_other = |layout: &Layout, id: &str| -> Vec<String> {
        Db::new(layout.clone())
            .unwrap()
            .with(id, |c, s| {
                let mut stmt = c.prepare(&format!(
                    "SELECT concat_ws(',', 'd', step, path_id, cohort, author_id, delta) FROM {s}.origin_deltas
                     UNION ALL SELECT concat_ws(',', 't', name, step, on_main) FROM {s}.tags ORDER BY 1"
                ))?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
            .unwrap()
    };
    assert_eq!(dump_other(&layout, &id), dump_other(&full_layout, &fid));
    assert!(
        dump_other(&layout, &id)
            .iter()
            .any(|r| r == "t,v1.0,4,true"),
        "tag placed after resume"
    );

    // Nothing new: returns at once, cache untouched.
    extract(&layout, &repo);
    let meta = layout.read_meta(&id).unwrap();
    assert_eq!(meta.last_run["steps_new"], 0);
    assert_eq!(meta.steps, 6);
}
