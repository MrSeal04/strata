//! `strata bench`: time extraction, peak memory and every query endpoint on one repo.

use std::sync::atomic::AtomicBool;
use std::time::Instant;

use clap::Args;
use strata_engine::ExtractOptions;
use strata_store::pipeline::extract_source;
use strata_store::{
    AreaMode, AreaQuery, Axis, Bins, CompositionQuery, Db, Filters, Layout, Slice, Source,
};

#[derive(Args)]
pub struct BenchArgs {
    /// Repo directory or git URL
    pub source: String,
    /// Force a full re-extract (otherwise incremental)
    #[arg(long)]
    pub full: bool,
    /// Query repetitions per endpoint
    #[arg(long, default_value_t = 7)]
    pub reps: usize,
    #[arg(long)]
    pub threads: Option<usize>,
    /// Compare surviving lines per author with `git blame -w HEAD` on this many sampled files
    #[arg(long, default_value_t = 0)]
    pub verify: usize,
}

fn rss_anon_mb() -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("RssAnon:"))
                .map(str::to_string)
        })
        .and_then(|l| {
            l.split_whitespace()
                .nth(1)
                .and_then(|v| v.parse::<f64>().ok())
        })
        .map_or(0.0, |kb| kb / 1024.0)
}

fn peak_rss_mb() -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmHWM:"))
                .map(str::to_string)
        })
        .and_then(|l| {
            l.split_whitespace()
                .nth(1)
                .and_then(|v| v.parse::<f64>().ok())
        })
        .map_or(0.0, |kb| kb / 1024.0)
}

fn dir_size(p: &std::path::Path) -> u64 {
    std::fs::read_dir(p)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

pub fn run(layout: Layout, args: BenchArgs) -> anyhow::Result<()> {
    let source = Source::parse(&args.source)?;
    let mut opts = ExtractOptions {
        full: args.full,
        ..Default::default()
    };
    if let Some(t) = args.threads {
        opts.threads = t;
    }
    // Peak anonymous memory (VmHWM also counts the memory-mapped pack files, which are reclaimable).
    let peak_anon = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let sampling = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    {
        let (peak, on) = (peak_anon.clone(), sampling.clone());
        std::thread::spawn(move || {
            while on.load(std::sync::atomic::Ordering::Relaxed) {
                peak.fetch_max(rss_anon_mb() as u64, std::sync::atomic::Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        });
    }
    let t0 = Instant::now();
    let mut rep = crate::progress::Reporter::new(false, false);
    let meta = extract_source(
        &layout,
        &source,
        &opts,
        false,
        None,
        &AtomicBool::new(false),
        &mut |p| rep.update(p),
    )?;
    rep.finish();
    let extract_s = t0.elapsed().as_secs_f64();
    let rss = peak_rss_mb();
    let size = dir_size(&layout.repo_dir(&meta.id)) as f64 / 1e6;
    println!(
        "repo            {} ({} steps, {} new)",
        meta.name, meta.steps, meta.last_run["steps_new"]
    );
    println!(
        "extract         {extract_s:.2}s  ({:.0} steps/s)",
        meta.last_run["steps_new"].as_f64().unwrap_or(0.0) / extract_s.max(1e-9)
    );
    sampling.store(false, std::sync::atomic::Ordering::Relaxed);
    println!("peak rss        {rss:.0} MB (incl. mapped pack files)");
    println!(
        "peak anon       {} MB",
        peak_anon.load(std::sync::atomic::Ordering::Relaxed)
    );
    println!(
        "merge blame     {} files blamed, {} credited by single-commit shortcut",
        meta.last_run["blame_calls"], meta.last_run["blame_shortcuts"]
    );
    println!("cache size      {size:.1} MB");

    let db = Db::new(layout.clone())?;
    let t = Instant::now();
    db.ensure_loaded(&meta.id)?;
    println!("load            {:.0} ms", t.elapsed().as_secs_f64() * 1e3);
    let f = Filters {
        exclude: vec![4, 5, 6, 7],
        ..Default::default()
    };
    let last = meta.steps.saturating_sub(1);
    let b = Bins {
        axis: Axis::Index,
        lo: 0.0,
        hi: f64::from(meta.steps),
        bins: 1600,
    };
    let bt = Bins {
        axis: Axis::Time,
        lo: meta.first_time as f64,
        hi: meta.last_time as f64 + 1.0,
        bins: 1600,
    };
    let id = meta.id.clone();
    type Q<'a> = Box<dyn Fn() -> anyhow::Result<usize> + 'a>;
    let area = |slice, mode| AreaQuery {
        slice,
        mode,
        depth: 1,
        top: 12,
        unit: "year".into(),
    };
    let comp = |slice, mode, from: i64, to: u32| CompositionQuery {
        area: area(slice, mode),
        keys: vec![],
        mode,
        from,
        to,
    };
    let queries: Vec<(&str, Q)> = vec![
        (
            "summary",
            Box::new(|| Ok(db.summary(&id)?.to_string().len())),
        ),
        ("axis", Box::new(|| Ok(db.axis(&id)?.len()))),
        ("paths", Box::new(|| Ok(db.paths(&id)?.len()))),
        ("bars/index", Box::new(|| Ok(db.bars(&id, &f, &b)?.len()))),
        ("bars/time", Box::new(|| Ok(db.bars(&id, &f, &bt)?.len()))),
        (
            "area/dir",
            Box::new(|| {
                Ok(db
                    .area(&id, &f, &b, &area(Slice::Dir, AreaMode::Size))?
                    .len())
            }),
        ),
        (
            "area/lang",
            Box::new(|| {
                Ok(db
                    .area(&id, &f, &b, &area(Slice::Lang, AreaMode::Size))?
                    .len())
            }),
        ),
        (
            "area/author",
            Box::new(|| {
                Ok(db
                    .area(&id, &f, &b, &area(Slice::Author, AreaMode::Size))?
                    .len())
            }),
        ),
        (
            "area/cohort",
            Box::new(|| {
                Ok(db
                    .area(&id, &f, &b, &area(Slice::Cohort, AreaMode::Size))?
                    .len())
            }),
        ),
        (
            "area/dir flow",
            Box::new(|| {
                Ok(db
                    .area(&id, &f, &b, &area(Slice::Dir, AreaMode::Flow))?
                    .len())
            }),
        ),
        (
            "state/last",
            Box::new(|| Ok(db.state(&id, last, &f)?.len())),
        ),
        (
            "state/mid",
            Box::new(|| Ok(db.state(&id, last / 2, &f)?.len())),
        ),
        (
            "events/200",
            Box::new(|| {
                Ok(db
                    .events(&id, i64::from(last / 2), last / 2 + 200, &f)?
                    .len())
            }),
        ),
        (
            "compare",
            Box::new(|| Ok(db.compare(&id, last / 2, last, &f)?.len())),
        ),
        (
            "step",
            Box::new(|| Ok(db.step(&id, last / 2, false)?.to_string().len())),
        ),
        (
            "step/brief",
            Box::new(|| Ok(db.step(&id, last / 2, true)?.to_string().len())),
        ),
        (
            "commits",
            Box::new(|| Ok(db.commits(&id, 0, last, &f, 20)?.len())),
        ),
        (
            "search/msg",
            Box::new(|| Ok(db.search(&id, "fix", "message", 20_000)?.to_string().len())),
        ),
        (
            "search/path",
            Box::new(|| Ok(db.search(&id, "src", "path", 20_000)?.to_string().len())),
        ),
        ("dirs", Box::new(|| Ok(db.dirs(&id, "", &f)?.len()))),
        // The treemap's data window: band keys, bands, churn and the steady layout's reference.
        (
            "keys/author",
            Box::new(|| {
                Ok(db
                    .keys(&id, &f, &b, &area(Slice::Author, AreaMode::Size))?
                    .len())
            }),
        ),
        (
            "composition",
            Box::new(|| {
                Ok(db
                    .composition(&id, &f, &comp(Slice::Author, AreaMode::Size, -1, last))?
                    .len())
            }),
        ),
        (
            "composition/flow",
            Box::new(|| {
                Ok(db
                    .composition(&id, &f, &comp(Slice::Cohort, AreaMode::Flow, -1, last))?
                    .len())
            }),
        ),
        (
            "origins/200",
            Box::new(|| {
                Ok(db
                    .origins(
                        &id,
                        &f,
                        &comp(
                            Slice::Author,
                            AreaMode::Size,
                            i64::from(last / 2),
                            last / 2 + 200,
                        ),
                    )?
                    .len())
            }),
        ),
        ("churn", Box::new(|| Ok(db.churn(&id, -1, last, &f)?.len()))),
        ("span", Box::new(|| Ok(db.span(&id, 0, last, &f)?.len()))),
        ("renames", Box::new(|| Ok(db.renames(&id, 0, last)?.len()))),
    ];
    println!(
        "{:<16}{:>10}{:>10}{:>10}{:>12}",
        "query", "cold p50", "cold p95", "cached", "bytes"
    );
    for (name, q) in &queries {
        let mut times = Vec::new();
        let mut bytes = 0;
        for _ in 0..args.reps.max(1) {
            db.clear_cache();
            let t = Instant::now();
            bytes = q()?;
            times.push(t.elapsed().as_secs_f64() * 1e3);
        }
        let t = Instant::now();
        q()?;
        let warm = t.elapsed().as_secs_f64() * 1e3;
        times.sort_by(f64::total_cmp);
        println!(
            "{name:<16}{:>10.1}{:>10.1}{warm:>10.1}{bytes:>12}",
            percentile(&times, 0.5),
            percentile(&times, 0.95)
        );
    }
    println!("peak rss (end)  {:.0} MB", peak_rss_mb());
    if args.verify > 0 {
        verify_blame(&db, &meta, args.verify)?;
    }
    Ok(())
}

/// Line-level agreement between strata's survival attribution and `git blame -w HEAD`.
fn verify_blame(db: &Db, meta: &strata_store::RepoMeta, n: usize) -> anyhow::Result<()> {
    use std::collections::HashMap;
    // Per path, lines per author email (ours).
    let ours: HashMap<String, HashMap<String, i64>> = db.with(&meta.id, |c, s| {
        let mut stmt = c.prepare(&format!(
            "SELECT p.path, lower(a.email), sum(o.delta)::BIGINT FROM {s}.origin_deltas o
             JOIN {s}.paths p USING (path_id) JOIN {s}.authors a ON a.author_id = o.author_id
             GROUP BY ALL HAVING sum(o.delta) > 0"
        ))?;
        let mut out: HashMap<String, HashMap<String, i64>> = HashMap::new();
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (p, e, v) = row?;
            out.entry(p).or_default().insert(e, v);
        }
        Ok(out)
    })?;
    // Deterministic sample of files, spread across the sorted path list.
    let mut paths: Vec<&String> = ours.keys().collect();
    paths.sort();
    let step = (paths.len() / n.max(1)).max(1);
    let sample: Vec<&String> = paths.iter().step_by(step).take(n).copied().collect();
    let (mut agree, mut total, mut files_exact, mut failed) = (0i64, 0i64, 0usize, 0usize);
    for path in &sample {
        // -C, not --git-dir: a local source's git_dir is its work tree, not its .git.
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&meta.git_dir)
            .args(["blame", "-w", "--line-porcelain", &meta.head, "--", path])
            .output()?;
        if !out.status.success() {
            failed += 1;
            continue;
        }
        let mut theirs: HashMap<String, i64> = HashMap::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some(mail) = line.strip_prefix("author-mail ") {
                *theirs
                    .entry(
                        mail.trim_start_matches('<')
                            .trim_end_matches('>')
                            .to_lowercase(),
                    )
                    .or_insert(0) += 1;
            }
        }
        let mine = &ours[*path];
        let lines: i64 = theirs.values().sum();
        let same: i64 = theirs
            .iter()
            .map(|(k, v)| (*v).min(*mine.get(k).unwrap_or(&0)))
            .sum();
        agree += same;
        total += lines;
        files_exact += usize::from(same == lines && mine.values().sum::<i64>() == lines);
    }
    if failed == sample.len() {
        anyhow::bail!("blame check: git blame failed on all {failed} sampled files");
    }
    println!(
        "blame check     {} files: {:.2}% of lines credited to the same author as git blame -w; {} files exact{}",
        sample.len() - failed,
        100.0 * agree as f64 / total.max(1) as f64,
        files_exact,
        if failed > 0 {
            format!(" ({failed} skipped: git blame failed)")
        } else {
            String::new()
        }
    );
    Ok(())
}
