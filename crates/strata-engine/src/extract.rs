//! Extraction orchestrator: walk the chain, diff steps on worker threads, feed results in step
//! order through the tracker into the sink, checkpoint periodically, resume incrementally.

use std::collections::BTreeMap;
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::Context;
use bstr::{BString, ByteSlice};
use crossbeam_channel::{bounded, unbounded};
use gix::ObjectId;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};

use crate::classify::{Classifier, PathFacts, lang_name};
use crate::config::RepoConfig;
use crate::diff::{DiffOptions, DiffWorker, StepDiff};
use crate::identity::{Identities, RawIdentity};
use crate::model::*;
use crate::tracker::{DeltaAcc, OriginId, Tracker};
use crate::walk::{self, Landing};

const CHECKPOINT_FORMAT: u32 = 1;
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Debug)]
pub struct ExtractOptions {
    pub branch: Option<String>,
    pub threads: usize,
    pub diff: DiffOptions,
    /// Ignore any checkpoint and re-extract everything.
    pub full: bool,
    pub checkpoint_every: Duration,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        let cpus = std::thread::available_parallelism().map_or(4, |n| n.get());
        Self {
            branch: None,
            threads: cpus.saturating_sub(1).max(1),
            diff: DiffOptions::default(),
            full: false,
            checkpoint_every: Duration::from_secs(120),
        }
    }
}

impl ExtractOptions {
    /// Everything that changes extracted data; a mismatch forces a full re-extract.
    fn fingerprint(&self) -> String {
        format!(
            "engine={ENGINE_VERSION};ws={};maxdiff={};renames={};blame={}/{}",
            self.diff.survival_ws_ignore,
            self.diff.max_diff_bytes,
            self.diff.rename_limit,
            self.diff.merge_blame,
            self.diff.blame_max_lines
        )
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub phase: &'static str,
    /// Steps finished in this run only (never counts work from earlier runs).
    pub done: u64,
    pub total: u64,
    pub steps_per_sec: f64,
    pub eta_secs: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ExtractReport {
    pub branch: String,
    pub head: String,
    pub steps_total: u32,
    pub steps_new: u32,
    pub resumed: bool,
    pub full_reason: Option<String>,
    pub cancelled: bool,
    pub inconsistent_files: u64,
    pub elapsed_secs: f64,
    pub first_time: i64,
    pub last_time: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct PathMeta {
    path: String,
    first_step: Step,
    last_step: Step,
    binary: bool,
    submodule: bool,
    generated_hint: bool,
}

#[derive(Serialize, Deserialize)]
struct Checkpoint {
    format: u32,
    fingerprint: String,
    branch: String,
    next_step: Step,
    last_sha: String,
    axis_max: i64,
    first_time: i64,
    paths: Vec<PathMeta>,
    identities: Vec<RawIdentity>,
    tracker: Tracker,
    rows_since_keyframe: u64,
}

fn checkpoint_path(state_dir: &Path) -> PathBuf {
    state_dir.join("checkpoint.bin")
}

fn load_checkpoint(state_dir: &Path) -> anyhow::Result<Option<Checkpoint>> {
    let path = checkpoint_path(state_dir);
    if !path.exists() {
        return Ok(None);
    }
    let f = std::fs::File::open(&path)?;
    let mut r = BufReader::new(zstd::Decoder::new(f)?);
    match bincode::serde::decode_from_std_read::<Checkpoint, _, _>(
        &mut r,
        bincode::config::standard(),
    ) {
        Ok(cp) if cp.format == CHECKPOINT_FORMAT => Ok(Some(cp)),
        _ => Ok(None), // unreadable or old format: start over
    }
}

/// Mutable extraction state (what the checkpoint persists, plus in-memory indexes).
struct State {
    paths: Vec<PathMeta>,
    path_ids: FxHashMap<BString, PathId>,
    ids: Identities,
    tracker: Tracker,
    axis_max: i64,
    first_time: i64,
    rows_since_keyframe: u64,
    inconsistent: u64,
}

impl State {
    fn intern(&mut self, path: &BString, step: Step) -> PathId {
        let id = match self.path_ids.get(path) {
            Some(&id) => id,
            None => {
                let id = self.paths.len() as PathId;
                self.paths.push(PathMeta {
                    path: path.to_str_lossy().into_owned(),
                    first_step: step,
                    ..Default::default()
                });
                self.path_ids.insert(path.clone(), id);
                id
            }
        };
        self.paths[id as usize].last_step = step;
        id
    }
}

fn sig_ref(s: &crate::diff::Signature) -> gix::actor::SignatureRef<'_> {
    gix::actor::SignatureRef {
        name: s.name.as_bstr(),
        email: s.email.as_bstr(),
        time: "",
    }
}

/// Turn one diffed step into rows, updating the tracker.
fn process_step(
    st: &mut State,
    landing: &mut Landing,
    repo: &gix::Repository,
    d: StepDiff,
) -> anyhow::Result<StepOutput> {
    let step = d.step;
    let c = &d.commit;
    let author_id = st.ids.resolve(sig_ref(&c.author), true);
    let committer_id = st.ids.resolve(sig_ref(&c.committer), false);
    st.axis_max = st.axis_max.max(c.committer.time);
    if step == 0 {
        st.first_time = c.committer.time;
    }

    let side = landing.land(
        repo,
        step,
        c.id,
        c.parents.get(1..).unwrap_or_default(),
        true,
    )?;
    let side_commits: Vec<SideCommitRow> = side
        .into_iter()
        .map(|s| SideCommitRow {
            sha: s.id.to_string(),
            landing_step: step,
            author_id: st.ids.resolve(sig_ref(&s.author), true),
            author_time: s.author.time,
            summary: s.summary,
        })
        .collect();

    // Default origin for new lines: this step's commit (for merges, lines blame couldn't place).
    let origin = st.tracker.new_origin(c.author.time, author_id);
    let mut blame_origins: FxHashMap<ObjectId, OriginId> = FxHashMap::default();
    let mut acc = DeltaAcc::default();
    let mut changes = Vec::with_capacity(d.files.len() + 4);
    let mut deltas = Vec::new();
    let mut row = StepRow {
        step,
        sha: c.id.to_string(),
        author_id,
        committer_id,
        author_time: c.author.time,
        commit_time: c.committer.time,
        axis_time: st.axis_max,
        is_merge: c.parents.len() > 1,
        side_count: side_commits.len() as u32,
        summary: c.message.lines().next().unwrap_or_default().to_string(),
        message: c.message.clone(),
        files_changed: d.files.len() as u32,
        ..Default::default()
    };
    if step == 0 || c.shallow_root {
        row.flags |= step_flags::IMPORT;
    }
    if c.shallow_root {
        row.flags |= step_flags::SHALLOW_ROOT;
    }

    // Phase 1: detach rename sources so their paths are free before anything else happens.
    let mut moved = Vec::new();
    for (i, f) in d.files.iter().enumerate() {
        if let (kind::RENAME, Some(old)) = (f.kind, &f.old_path) {
            let old_id = st.intern(old, step);
            let state = st.tracker.take(old_id).unwrap_or_default();
            // The lines leave the old path (and arrive at the new one below).
            st.tracker.account_all(&state, -1, &mut acc);
            acc.drain_into(step, old_id, &mut deltas);
            changes.push(ChangeRow {
                step,
                path_id: old_id,
                kind: kind::RENAME_SOURCE,
                old_path_id: NO_PATH,
                line_delta: -(state.lines as i32),
                top_author: u32::MAX,
                ..Default::default()
            });
            moved.push((i, old_id, state));
        }
    }
    let mut moved: FxHashMap<usize, (PathId, crate::tracker::FileState)> =
        moved.into_iter().map(|(i, id, s)| (i, (id, s))).collect();

    // Phase 2: everything else.
    for (i, f) in d.files.iter().enumerate() {
        let path_id = st.intern(&f.path, step);
        {
            let meta = &mut st.paths[path_id as usize];
            meta.binary = f.binary;
            meta.submodule |= f.submodule;
            meta.generated_hint |= f.generated_hint;
        }
        row.adds += f.adds;
        row.dels += f.dels;
        row.adds_ws += f.adds_ws;
        row.dels_ws += f.dels_ws;
        if f.approx {
            row.flags |= step_flags::APPROX;
        }
        // A rename destination is a new path: its lines arrive with this row (the source row
        // already subtracted them), so measure `before` prior to attaching the moved state.
        let before = st.tracker.get(path_id).map_or(0, |s| s.lines);
        let mut old_path_id = NO_PATH;
        if let Some((old_id, state)) = moved.remove(&i) {
            old_path_id = old_id;
            st.tracker.account_all(&state, 1, &mut acc);
            st.tracker.put(path_id, state);
        }

        if f.kind == kind::DELETE {
            st.tracker.delete(path_id, &mut acc);
        } else if f.submodule || f.binary {
            st.tracker.set_binary(
                path_id,
                if f.submodule { 0 } else { f.bytes_after },
                &mut acc,
            );
        } else {
            // Merge steps with blame: each added line gets the side commit that wrote it.
            let runs: Vec<(u32, u32, OriginId)> = match &f.blame {
                Some(b) => b
                    .iter()
                    .map(|r| {
                        let o = match &r.origin {
                            Some(bo) => *blame_origins.entry(bo.sha).or_insert_with(|| {
                                let sig = gix::actor::SignatureRef {
                                    name: bo.name.as_bstr(),
                                    email: bo.email.as_bstr(),
                                    time: "",
                                };
                                let aid = st.ids.resolve(sig, false);
                                st.tracker.new_origin(bo.time, aid)
                            }),
                            None => origin,
                        };
                        (r.start, r.len, o)
                    })
                    .collect(),
                None => Vec::new(),
            };
            let origin_of = |line: u32| -> OriginId {
                let i = runs.partition_point(|&(s, _, _)| s <= line);
                match i.checked_sub(1).map(|i| runs[i]) {
                    Some((s, n, o)) if line < s + n => o,
                    _ => origin,
                }
            };
            if !st.tracker.apply(
                path_id,
                &f.hunks,
                f.new_lines,
                f.bytes_after,
                &origin_of,
                &mut acc,
            ) {
                st.inconsistent += 1;
            }
        }

        let (lines_after, mean, (top_author, top_share)) = match st.tracker.get(path_id) {
            Some(s) if f.kind != kind::DELETE => (s.lines, s.mean_origin_time(), s.top_author()),
            _ => (0, 0, (u32::MAX, 0.0)),
        };
        changes.push(ChangeRow {
            step,
            path_id,
            kind: f.kind,
            old_path_id,
            adds: f.adds,
            dels: f.dels,
            adds_ws: f.adds_ws,
            dels_ws: f.dels_ws,
            lines_after,
            line_delta: lines_after as i32 - before as i32,
            bytes_after: if f.kind == kind::DELETE {
                0
            } else {
                f.bytes_after
            },
            mean_origin_time: mean,
            top_author,
            top_share,
            binary: f.binary,
            approx: f.approx,
        });
        acc.drain_into(step, path_id, &mut deltas);
    }
    Ok(StepOutput {
        step: row,
        changes,
        deltas,
        side_commits,
    })
}

/// Run extraction for the repo at `repo_dir`, keeping resumable state in `state_dir`.
pub fn extract(
    repo_dir: &Path,
    state_dir: &Path,
    cfg: &RepoConfig,
    sink: &mut dyn Sink,
    opts: &ExtractOptions,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&Progress),
) -> anyhow::Result<ExtractReport> {
    let started = Instant::now();
    std::fs::create_dir_all(state_dir)?;
    let mut repo =
        gix::open(repo_dir).with_context(|| format!("opening {}", repo_dir.display()))?;
    repo.object_cache_size_if_unset(64 << 20);
    progress(&Progress {
        phase: "walk",
        done: 0,
        total: 0,
        steps_per_sec: 0.0,
        eta_secs: None,
    });

    let branch_pref = opts.branch.clone().or_else(|| cfg.branch.clone());
    let (branch, tip) = walk::resolve_tip(&repo, branch_pref.as_deref())?;
    let fingerprint = opts.fingerprint();

    let mut full_reason = None;
    let mut cp = if opts.full {
        None
    } else {
        load_checkpoint(state_dir)?
    };
    if let Some(c) = &cp {
        if c.fingerprint != fingerprint {
            full_reason = Some("extraction settings or engine version changed".to_string());
        } else if c.branch != branch {
            full_reason = Some(format!("branch changed from {} to {branch}", c.branch));
        }
        if full_reason.is_some() {
            cp = None;
        }
    }
    let stop = cp
        .as_ref()
        .and_then(|c| c.last_sha.parse::<ObjectId>().ok());
    let mut chain = walk::first_parent_chain(&repo, tip, stop)?;
    if stop.is_some() && !chain.resumed {
        full_reason =
            Some("history was rewritten (last extracted commit is no longer on the branch)".into());
        cp = None;
        chain = walk::first_parent_chain(&repo, tip, None)?;
    }
    // Rebuild the landing map (commit -> step) for the already-extracted part of history.
    let mut landing = Landing::default();
    let mut chain_ids: Vec<ObjectId> = Vec::new();
    if let (Some(stop), Some(c)) = (stop, cp.as_ref()) {
        progress(&Progress {
            phase: "reindex",
            done: 0,
            total: 0,
            steps_per_sec: 0.0,
            eta_secs: None,
        });
        let old = walk::first_parent_chain(&repo, stop, None)?;
        if old.ids.len() as Step != c.next_step {
            full_reason = Some("checkpoint does not match the history on disk".into());
            cp = None;
            chain = walk::first_parent_chain(&repo, tip, None)?;
        } else {
            for (i, &id) in old.ids.iter().enumerate() {
                let parents: Vec<ObjectId> = repo
                    .find_commit(id)?
                    .parent_ids()
                    .map(|p| p.detach())
                    .collect();
                landing.land(
                    &repo,
                    i as Step,
                    id,
                    parents.get(1..).unwrap_or_default(),
                    false,
                )?;
            }
            chain_ids = old.ids;
        }
    }
    chain_ids.extend_from_slice(&chain.ids);
    let resumed = cp.is_some();
    let start_step = cp.as_ref().map_or(0, |c| c.next_step);

    let mailmap = repo.open_mailmap();
    let mut st = match cp {
        Some(c) => State {
            path_ids: c
                .paths
                .iter()
                .enumerate()
                .map(|(i, p)| (BString::from(p.path.as_str()), i as PathId))
                .collect(),
            paths: c.paths,
            ids: Identities::new(mailmap, c.identities),
            tracker: c.tracker,
            axis_max: c.axis_max,
            first_time: c.first_time,
            rows_since_keyframe: c.rows_since_keyframe,
            inconsistent: 0,
        },
        None => State {
            paths: Vec::new(),
            path_ids: FxHashMap::default(),
            ids: Identities::new(mailmap, Vec::new()),
            tracker: Tracker::default(),
            axis_max: i64::MIN,
            first_time: 0,
            rows_since_keyframe: 0,
            inconsistent: 0,
        },
    };
    sink.begin(start_step)?;

    // Parallel diff pipeline with a bounded reorder window.
    let total = chain.ids.len() as u64;
    let threads = opts.threads.max(1);
    let window = threads * 8;
    let safe = repo.clone().into_sync();
    let (job_tx, job_rx) = bounded::<(Step, ObjectId)>(threads * 2);
    let (res_tx, res_rx) = unbounded::<anyhow::Result<StepDiff>>();
    let (permit_tx, permit_rx) = bounded::<()>(window);
    for _ in 0..window {
        permit_tx.send(()).ok();
    }

    let mut cancelled = false;
    let mut done = 0u64;
    let mut last_cp = Instant::now();
    let mut last_progress = Instant::now();
    let mut ema_rate: Option<f64> = None;
    let mut rate_mark = (Instant::now(), 0u64);

    let run: anyhow::Result<()> = std::thread::scope(|s| {
        let ids = &chain.ids;
        s.spawn(move || {
            for (i, &id) in ids.iter().enumerate() {
                if permit_rx.recv().is_err() || job_tx.send((start_step + i as Step, id)).is_err() {
                    break;
                }
            }
        });
        for _ in 0..threads {
            let job_rx = job_rx.clone();
            let res_tx = res_tx.clone();
            let safe = safe.clone();
            let dopts = opts.diff.clone();
            s.spawn(move || {
                let mut repo = safe.to_thread_local();
                repo.object_cache_size_if_unset(32 << 20);
                let mut worker = match DiffWorker::new(repo, dopts) {
                    Ok(w) => w,
                    Err(e) => {
                        res_tx.send(Err(e)).ok();
                        return;
                    }
                };
                while let Ok((step, id)) = job_rx.recv() {
                    if res_tx.send(worker.run(step, id)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(job_rx);
        drop(res_tx);

        let result = (|| -> anyhow::Result<()> {
            let mut pending: BTreeMap<Step, StepDiff> = BTreeMap::new();
            let mut next = start_step;
            for res in res_rx.iter() {
                let d = res?;
                pending.insert(d.step, d);
                while let Some(d) = pending.remove(&next) {
                    let out = process_step(&mut st, &mut landing, &repo, d)?;
                    st.rows_since_keyframe += out.changes.len() as u64;
                    sink.write_step(out)?;
                    if st.rows_since_keyframe >= (2 * st.tracker.live_files() as u64).max(50_000) {
                        sink.write_keyframe(next, st.tracker.keyframe(next))?;
                        st.rows_since_keyframe = 0;
                    }
                    next += 1;
                    done += 1;
                    permit_tx.send(()).ok();

                    if last_progress.elapsed() >= Duration::from_millis(500) || done == total {
                        let dt = rate_mark.0.elapsed().as_secs_f64();
                        if dt >= 2.0 {
                            let r = (done - rate_mark.1) as f64 / dt;
                            ema_rate = Some(ema_rate.map_or(r, |e| 0.7 * e + 0.3 * r));
                            rate_mark = (Instant::now(), done);
                        }
                        let rate = ema_rate
                            .unwrap_or(done as f64 / started.elapsed().as_secs_f64().max(1e-3));
                        progress(&Progress {
                            phase: "diff",
                            done,
                            total,
                            steps_per_sec: rate,
                            eta_secs: (rate > 0.0).then(|| (total - done) as f64 / rate),
                        });
                        last_progress = Instant::now();
                    }
                    if last_cp.elapsed() >= opts.checkpoint_every {
                        sink.flush()?;
                        save_checkpoint(
                            state_dir,
                            &snapshot(
                                &st,
                                &fingerprint,
                                &branch,
                                next,
                                chain_ids[next as usize - 1],
                            ),
                        )?;
                        last_cp = Instant::now();
                    }
                    if cancel.load(Ordering::Relaxed) {
                        cancelled = true;
                        return Ok(());
                    }
                }
            }
            Ok(())
        })();
        drop(permit_tx);
        drop(res_rx);
        result
    });
    run?;

    let steps_done_to = start_step + done as Step;
    progress(&Progress {
        phase: "finish",
        done,
        total,
        steps_per_sec: 0.0,
        eta_secs: None,
    });

    // Dimension tables.
    let tip_tree = repo.find_commit(tip)?.tree_id()?.detach();
    let classifier = Classifier::new(&walk::attribute_files(&repo, tip_tree)?, cfg);
    let paths = st
        .paths
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let facts = PathFacts {
                binary: p.binary,
                submodule: p.submodule,
                generated_hint: p.generated_hint,
            };
            let (category, lang) = classifier.classify(&p.path, facts);
            PathRow {
                path_id: i as PathId,
                path: p.path.clone(),
                lang: lang_name(lang).to_string(),
                category,
                first_step: p.first_step,
                last_step: p.last_step,
            }
        })
        .collect();
    let authors = st.ids.finalize(&cfg.identities);
    let mut tags: Vec<TagRow> = walk::tags(&repo)?
        .into_iter()
        .filter_map(|t| {
            let step = landing.step_of(&t.commit)?;
            (step < steps_done_to).then(|| TagRow {
                on_main: chain_ids.get(step as usize) == Some(&t.commit),
                name: t.name,
                sha: t.commit.to_string(),
                step,
                time: t.time,
            })
        })
        .collect();
    tags.sort_by(|a, b| (a.step, &a.name).cmp(&(b.step, &b.name)));
    sink.finish(Dimensions {
        paths,
        authors,
        tags,
    })?;
    if steps_done_to > 0 {
        save_checkpoint(
            state_dir,
            &snapshot(
                &st,
                &fingerprint,
                &branch,
                steps_done_to,
                chain_ids[steps_done_to as usize - 1],
            ),
        )?;
    }

    Ok(ExtractReport {
        branch,
        head: chain_ids
            .get(steps_done_to.saturating_sub(1) as usize)
            .map(|i| i.to_string())
            .unwrap_or_default(),
        steps_total: steps_done_to,
        steps_new: done as u32,
        resumed,
        full_reason,
        cancelled,
        inconsistent_files: st.inconsistent,
        elapsed_secs: started.elapsed().as_secs_f64(),
        first_time: st.first_time,
        last_time: st.axis_max,
    })
}

fn snapshot<'a>(
    st: &'a State,
    fingerprint: &str,
    branch: &str,
    next_step: Step,
    last: ObjectId,
) -> SnapshotRef<'a> {
    SnapshotRef {
        format: CHECKPOINT_FORMAT,
        fingerprint: fingerprint.to_string(),
        branch: branch.to_string(),
        next_step,
        last_sha: last.to_string(),
        axis_max: st.axis_max,
        first_time: st.first_time,
        paths: &st.paths,
        identities: st.ids.raw(),
        tracker: &st.tracker,
        rows_since_keyframe: st.rows_since_keyframe,
    }
}

/// Borrowing twin of `Checkpoint` so saving doesn't clone the tracker. Field order must match.
#[derive(Serialize)]
struct SnapshotRef<'a> {
    format: u32,
    fingerprint: String,
    branch: String,
    next_step: Step,
    last_sha: String,
    axis_max: i64,
    first_time: i64,
    paths: &'a [PathMeta],
    identities: &'a [RawIdentity],
    tracker: &'a Tracker,
    rows_since_keyframe: u64,
}

fn save_checkpoint(state_dir: &Path, cp: &SnapshotRef<'_>) -> anyhow::Result<()> {
    let path = checkpoint_path(state_dir);
    let tmp = path.with_extension("bin.tmp");
    {
        let f = std::fs::File::create(&tmp)?;
        let mut w = BufWriter::new(zstd::Encoder::new(f, 3)?.auto_finish());
        bincode::serde::encode_into_std_write(cp, &mut w, bincode::config::standard())?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
