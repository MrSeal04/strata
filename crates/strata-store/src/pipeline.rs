//! End-to-end extraction for one source: clone/fetch if remote, load config, run the engine
//! into a `ParquetSink`, write `meta.json`.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;

use anyhow::{Context, bail};
use serde::Serialize;
use strata_engine::{ExtractOptions, RepoConfig};

use crate::layout::{Layout, RepoMeta, Source};
use crate::sink::ParquetSink;

#[derive(Clone, Debug, Default, Serialize)]
pub struct JobProgress {
    pub phase: String,
    /// Units finished by this job only (steps, or clone percent).
    pub done: u64,
    pub total: u64,
    pub steps_per_sec: f64,
    pub eta_secs: Option<f64>,
    pub message: Option<String>,
}

/// Run a git command, forwarding its progress lines ("Receiving objects:  42% ...") to `progress`.
fn git_with_progress(args: &[&str], cwd: Option<&Path>, progress: &mut dyn FnMut(&JobProgress)) -> anyhow::Result<()> {
    let mut cmd = Command::new("git");
    cmd.args(args).stdout(Stdio::null()).stderr(Stdio::piped());
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    let mut child = cmd.spawn().context("running git")?;
    let stderr = child.stderr.take().expect("piped");
    let mut tail = Vec::new();
    // git progress uses '\r' to redraw; split on both.
    let mut reader = BufReader::new(stderr);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = read_until_any(&mut reader, &mut buf)?;
        if n == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&buf).trim().to_string();
        if line.is_empty() {
            continue;
        }
        let pct = line
            .split_whitespace()
            .find_map(|w| w.strip_suffix('%'))
            .and_then(|p| p.parse::<u64>().ok());
        progress(&JobProgress {
            phase: "clone".into(),
            done: pct.unwrap_or(0),
            total: 100,
            message: Some(line.clone()),
            ..Default::default()
        });
        tail.push(line);
        if tail.len() > 20 {
            tail.remove(0);
        }
    }
    let status = child.wait()?;
    if !status.success() {
        bail!("git {} failed:\n{}", args.join(" "), tail.join("\n"));
    }
    Ok(())
}

fn read_until_any(r: &mut impl BufRead, out: &mut Vec<u8>) -> std::io::Result<usize> {
    let mut total = 0;
    loop {
        let (done, used) = {
            let available = r.fill_buf()?;
            if available.is_empty() {
                return Ok(total);
            }
            match available.iter().position(|&b| b == b'\n' || b == b'\r') {
                Some(i) => {
                    out.extend_from_slice(&available[..=i]);
                    (true, i + 1)
                }
                None => {
                    out.extend_from_slice(available);
                    (false, available.len())
                }
            }
        };
        r.consume(used);
        total += used;
        if done {
            return Ok(total);
        }
    }
}

/// The git directory to read: the path itself for local repos, a bare mirror for URLs.
pub fn prepare_git_dir(layout: &Layout, source: &Source, fetch: bool, progress: &mut dyn FnMut(&JobProgress)) -> anyhow::Result<PathBuf> {
    match source {
        Source::Path { path } => Ok(path.clone()),
        Source::Url { url } => {
            let dir = layout.clone_dir(url);
            if dir.join("HEAD").exists() {
                if fetch {
                    git_with_progress(
                        &["fetch", "--progress", "--prune", "--tags", "origin", "+refs/heads/*:refs/heads/*"],
                        Some(&dir),
                        progress,
                    )?;
                }
            } else {
                std::fs::create_dir_all(dir.parent().unwrap())?;
                let tmp = dir.with_extension("partial");
                let _ = std::fs::remove_dir_all(&tmp);
                git_with_progress(&["clone", "--bare", "--progress", url, &tmp.to_string_lossy()], None, progress)?;
                std::fs::rename(&tmp, &dir)?;
            }
            Ok(dir)
        }
    }
}

/// Extract `source` into the cache and return its fresh metadata.
pub fn extract_source(
    layout: &Layout,
    source: &Source,
    opts: &ExtractOptions,
    fetch: bool,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&JobProgress),
) -> anyhow::Result<RepoMeta> {
    let git_dir = prepare_git_dir(layout, source, fetch, progress)?;
    let id = source.id();
    let dir = layout.repo_dir(&id);
    std::fs::create_dir_all(&dir)?;
    let repo_cfg = git_dir.join(".strata.toml");
    let cache_cfg = dir.join("strata.toml");
    let cfg = RepoConfig::load(&[&repo_cfg, &cache_cfg])?;
    let mut sink = ParquetSink::new(&dir)?;
    let report = strata_engine::extract(&git_dir, &dir, &cfg, &mut sink, opts, cancel, &mut |p| {
        progress(&JobProgress {
            phase: p.phase.to_string(),
            done: p.done,
            total: p.total,
            steps_per_sec: p.steps_per_sec,
            eta_secs: p.eta_secs,
            message: None,
        })
    })?;
    let meta = RepoMeta {
        id,
        name: source.name(),
        source: source.clone(),
        git_dir,
        branch: report.branch.clone(),
        head: report.head.clone(),
        steps: report.steps_total,
        first_time: report.first_time,
        last_time: report.last_time,
        engine_version: strata_engine::extract::ENGINE_VERSION.to_string(),
        updated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64),
        last_run: serde_json::to_value(&report)?,
    };
    layout.write_meta(&meta)?;
    Ok(meta)
}
