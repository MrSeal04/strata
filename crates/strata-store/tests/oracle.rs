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

/// Per first-parent commit (by sha): each live path and the step that last changed its content,
/// replayed from `git log --raw`. A move with identical content (R100) keeps its source's edit;
/// everything else that names a path (add, modify, type change, rename with changes) edits it.
fn git_last_edits(
    repo: &Path,
    gitlinks: &std::collections::HashSet<String>,
) -> Vec<(String, HashMap<String, u32>)> {
    let mut out: Vec<(String, HashMap<String, u32>)> = Vec::new();
    let mut live: HashMap<String, u32> = HashMap::new();
    let log = git(
        repo,
        &[
            "log",
            "--first-parent",
            "-M",
            "--raw",
            "--format=@%H",
            "--reverse",
        ],
    );
    for line in log.lines() {
        if let Some(sha) = line.strip_prefix('@') {
            if let Some(last) = out.last_mut() {
                last.1 = live.clone();
            }
            out.push((sha.to_string(), HashMap::new()));
            continue;
        }
        let Some((meta, paths)) = line.strip_prefix(':').and_then(|l| l.split_once('\t')) else {
            continue;
        };
        let step = (out.len() - 1) as u32;
        let status = meta.split_whitespace().nth(4).unwrap_or("");
        let paths: Vec<&str> = paths.split('\t').collect();
        match status.chars().next() {
            Some('R') => {
                let from = live.remove(paths[0]);
                let e = if status == "R100" {
                    from.unwrap_or(step)
                } else {
                    step
                };
                live.insert(paths[1].to_string(), e);
            }
            Some('D') => {
                live.remove(paths[0]);
            }
            _ => {
                live.insert(paths[0].to_string(), step);
            }
        }
    }
    if let Some(last) = out.last_mut() {
        last.1 = live;
    }
    for (_, m) in &mut out {
        m.retain(|p, _| !gitlinks.contains(p));
    }
    out
}

/// (path_id, lines, edited) rows of a /state response.
fn state_rows(bytes: &[u8]) -> Vec<(u32, i64, i64)> {
    use arrow::array::{Array, Int64Array};
    let reader =
        arrow::ipc::reader::StreamReader::try_new(std::io::Cursor::new(bytes), None).unwrap();
    let mut rows = Vec::new();
    for batch in reader {
        let b = batch.unwrap();
        let get = |name: &str| {
            let c = arrow::compute::cast(
                b.column_by_name(name).unwrap(),
                &arrow::datatypes::DataType::Int64,
            )
            .unwrap();
            c.as_any().downcast_ref::<Int64Array>().unwrap().clone()
        };
        let (id, lines, edited) = (get("path_id"), get("lines"), get("edited"));
        for i in 0..b.num_rows() {
            let e = if edited.is_null(i) {
                -1
            } else {
                edited.value(i)
            };
            rows.push((id.value(i) as u32, lines.value(i), e));
        }
    }
    rows
}

fn extract(layout: &Layout, repo: &Path) -> String {
    let src = Source::parse(repo.to_str().unwrap()).unwrap();
    let opts = ExtractOptions {
        threads: 3,
        // Keyframes every few steps, so state reconstruction from keyframes is exercised too.
        keyframe_min_rows: 1,
        ..Default::default()
    };
    let meta = extract_source(
        layout,
        &src,
        &opts,
        false,
        None,
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .unwrap_or_else(|e| panic!("extracting {}: {e:#}", repo.display()));
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

    // 5. At every step, /state (keyframe + later changes) holds exactly the live files, with the
    //    line counts of a changes-only replay and each file's last content edit as git sees it.
    let gitlinks: std::collections::HashSet<String> =
        git(&repo, &["log", "--all", "--raw", "--format="])
            .lines()
            .filter(|l| l.starts_with(':') && l.contains("160000"))
            .filter_map(|l| l.split('\t').next_back().map(str::to_string))
            .collect();
    let (paths, shas): (HashMap<u32, String>, HashMap<String, u32>) = db
        .with(&id, |c, s| {
            let mut stmt = c.prepare(&format!("SELECT path_id, path FROM {s}.paths"))?;
            let paths = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            let mut stmt = c.prepare(&format!("SELECT sha, step FROM {s}.steps"))?;
            let shas = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            Ok((paths, shas))
        })
        .unwrap();
    let keyframes: i64 = db
        .with(&id, |c, s| {
            Ok(
                c.query_row(&format!("SELECT count(*) FROM {s}.kf_steps"), [], |r| {
                    r.get(0)
                })?,
            )
        })
        .unwrap();
    // (kitchen never has 2 × its live files in changes between keyframes, so it has none)
    assert!(
        keyframes > 0 || name == "kitchen",
        "{name}: no keyframes, so the keyframe path goes untested"
    );
    for (sha, want) in git_last_edits(&repo, &gitlinks) {
        let step = shas[&sha];
        let rows = state_rows(&db.state(&id, step, &Filters::default()).unwrap());
        let lines: HashMap<u32, i64> = db
            .with(&id, |c, s| {
                let mut stmt = c.prepare(&state_sql_for_test(s, step))?;
                let rows =
                    stmt.query_map([], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, i64>(1)?)))?;
                Ok(rows.collect::<Result<_, _>>()?)
            })
            .unwrap();
        let got: HashMap<String, u32> = rows
            .iter()
            .filter(|(p, _, _)| !gitlinks.contains(&paths[p]))
            .map(|(p, _, e)| (paths[p].clone(), *e as u32))
            .collect();
        assert_eq!(
            got, want,
            "{name}: last edits at step {step} differ from git"
        );
        for (p, l, _) in &rows {
            assert_eq!(
                Some(l),
                lines.get(p),
                "{name}: lines of {} at step {step}",
                paths[p]
            );
        }
    }

    // 6. The query endpoints run.
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
fn moves_matches_git() {
    check_repo("moves");
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

#[test]
fn shallow_clone_starts_with_an_import_step() {
    let work = tempfile::tempdir().unwrap();
    let repo = work.path().join("shallow");
    let src = format!("file://{}", fixtures().join("linear").display());
    let out = Command::new("git")
        .args(["clone", "-q", "--depth", "3", &src])
        .arg(&repo)
        .output()
        .unwrap();
    assert!(out.status.success());
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().to_path_buf());
    let id = extract(&layout, &repo);
    let db = Db::new(layout.clone()).unwrap();
    let (steps, flags0, lines): (u32, u8, i64) = db
        .with(&id, |c, s| {
            Ok(c.query_row(
                &format!(
                    "SELECT (SELECT count(*) FROM {s}.steps)::UINTEGER, (SELECT flags FROM {s}.steps WHERE step = 0),
                            (SELECT sum(line_delta) FROM {s}.changes)::BIGINT"
                ),
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?)
        })
        .unwrap();
    assert_eq!(steps, 3);
    assert_eq!(flags0 & 5, 5, "first step flagged IMPORT | SHALLOW_ROOT");
    // HEAD of `linear` has 12 + 7 + 1 lines.
    assert_eq!(lines, 20);
}

/// Last-bin totals of a size-mode area query (decoded from Arrow IPC).
fn area_total(bytes: &[u8]) -> f64 {
    use arrow::array::{Array, Float64Array, Int32Array};
    let reader =
        arrow::ipc::reader::StreamReader::try_new(std::io::Cursor::new(bytes), None).unwrap();
    let mut last: std::collections::HashMap<String, (i32, f64)> = Default::default();
    for batch in reader {
        let b = batch.unwrap();
        let bins = b
            .column_by_name("bin")
            .unwrap()
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap()
            .clone();
        let keys = arrow::compute::cast(
            b.column_by_name("key").unwrap(),
            &arrow::datatypes::DataType::Utf8,
        )
        .unwrap();
        let keys = keys
            .as_any()
            .downcast_ref::<arrow::array::StringArray>()
            .unwrap()
            .clone();
        let vals = b
            .column_by_name("value")
            .unwrap()
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap()
            .clone();
        for i in 0..b.num_rows() {
            let e = last
                .entry(keys.value(i).to_string())
                .or_insert((i32::MIN, 0.0));
            if bins.value(i) >= e.0 {
                *e = (bins.value(i), vals.value(i));
            }
        }
    }
    last.values().map(|(_, v)| v).sum()
}

#[test]
fn area_aggregates_match_direct_queries() {
    let repo = fixtures().join("kitchen");
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().to_path_buf());
    let id = extract(&layout, &repo);
    let db = Db::new(layout.clone()).unwrap();
    let bins = strata_store::Bins {
        axis: strata_store::Axis::Index,
        lo: 0.0,
        hi: 9.0,
        bins: 9,
    };
    for exclude in [vec![], vec![4u8, 5, 6, 7]] {
        let ex = exclude
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let want: f64 = db
            .with(&id, |c, s| {
                let cat = if ex.is_empty() { String::new() } else { format!("WHERE p.category NOT IN ({ex})") };
                Ok(c.query_row(
                    &format!("SELECT coalesce(sum(line_delta), 0)::DOUBLE FROM {s}.changes JOIN {s}.paths p USING (path_id) {cat}"),
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        for slice in [
            strata_store::Slice::Dir,
            strata_store::Slice::Lang,
            strata_store::Slice::Author,
            strata_store::Slice::Cohort,
        ] {
            let q = strata_store::AreaQuery {
                slice,
                mode: strata_store::AreaMode::Size,
                depth: 1,
                top: 60,
                unit: "month".into(),
            };
            let f = Filters {
                exclude: exclude.clone(),
                ..Default::default()
            };
            let got = area_total(&db.area(&id, &f, &bins, &q).unwrap());
            assert_eq!(got, want, "{slice:?} aggregated total (exclude {ex})");
            // A folder filter forces the direct (non-aggregated) query; "app" is one subtree.
            let f_root = Filters {
                exclude: exclude.clone(),
                root: "app".into(),
                ..Default::default()
            };
            let direct = area_total(&db.area(&id, &f_root, &bins, &q).unwrap());
            let under_app: f64 = db
                .with(&id, |c, s| {
                    let cat = if ex.is_empty() { String::new() } else { format!("AND p.category NOT IN ({ex})") };
                    Ok(c.query_row(
                        &format!("SELECT coalesce(sum(line_delta), 0)::DOUBLE FROM {s}.changes JOIN {s}.paths p USING (path_id) WHERE p.path LIKE 'app/%' {cat}"),
                        [],
                        |r| r.get(0),
                    )?)
                })
                .unwrap();
            assert_eq!(
                direct, under_app,
                "{slice:?} direct total under app/ (exclude {ex})"
            );
        }
    }
}
