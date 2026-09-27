//! Per-step diffing: tree diff with rename tracking, then a histogram line diff per changed blob
//! (plus a whitespace-insensitive one for the `-w` counts). Runs on worker threads.

use std::hash::{Hash, Hasher};
use std::ops::ControlFlow;

use anyhow::Context;
use bstr::{BString, ByteSlice};
use gix::ObjectId;
use gix::diff::blob::{Algorithm, Diff, InternedInput};
use gix::diff::tree::recorder::Location;
use gix::diff::tree_with_rewrites::{Change, Options as TreeDiffOptions};
use gix::objs::TreeRefIter;
use rustc_hash::FxHasher;
use smallvec::SmallVec;

use crate::classify::looks_generated;
use crate::model::{Step, kind};
use crate::tracker::Hunk;

#[derive(Clone, Debug)]
pub struct DiffOptions {
    /// Blobs larger than this are not line-diffed; counts become line-count deltas (`approx`).
    pub max_diff_bytes: u64,
    /// Track survival with whitespace-insensitive alignment (a reformat doesn't make code "new").
    pub survival_ws_ignore: bool,
    pub rename_limit: usize,
    /// Attribute lines a merge adds to the side-branch commits that wrote them (ranged blame).
    /// Off = credit the merge commit's author.
    pub merge_blame: bool,
    /// Merges adding more lines than this fall back to merger attribution (bounds the cost).
    pub blame_max_lines: u32,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            max_diff_bytes: 16 << 20,
            survival_ws_ignore: true,
            rename_limit: 1000,
            merge_blame: true,
            blame_max_lines: 400_000,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Signature {
    pub name: BString,
    pub email: BString,
    pub time: i64,
}

#[derive(Clone, Debug)]
pub struct CommitInfo {
    pub id: ObjectId,
    pub parents: SmallVec<[ObjectId; 2]>,
    pub author: Signature,
    pub committer: Signature,
    pub message: String,
    /// The first parent exists in the chain but its object is missing (shallow clone).
    pub shallow_root: bool,
}

#[derive(Clone, Debug, Default)]
pub struct FileDiff {
    pub path: BString,
    pub old_path: Option<BString>,
    pub kind: u8,
    pub submodule: bool,
    pub binary: bool,
    pub approx: bool,
    pub generated_hint: bool,
    pub old_lines: u32,
    pub new_lines: u32,
    pub bytes_after: u64,
    pub adds: u32,
    pub dels: u32,
    pub adds_ws: u32,
    pub dels_ws: u32,
    /// Hunks the tracker applies (whitespace-insensitive or strict, per `DiffOptions`).
    pub hunks: Vec<Hunk>,
    /// Merge steps: who wrote the added lines (see `blame`).
    pub blame: Option<Vec<crate::blame::BlameRun>>,
    /// Blob id after the change (None for deletions / trees).
    pub new_id: Option<ObjectId>,
}

/// One side commit's change to a path (old/new blob ids; None = absent).
#[derive(Clone, Copy, Debug)]
struct Touch {
    side: usize,
    old: Option<ObjectId>,
    new: Option<ObjectId>,
}

#[derive(Debug)]
pub struct StepDiff {
    pub step: Step,
    pub commit: CommitInfo,
    pub files: Vec<FileDiff>,
    /// Commits this (merge) step brings in from its other parents.
    pub side: Vec<crate::walk::SideCommit>,
}

pub fn read_signature(sig: gix::actor::SignatureRef<'_>) -> Signature {
    Signature {
        name: sig.name.into(),
        email: sig.email.into(),
        time: sig.time().map(|t| t.seconds).unwrap_or(0),
    }
}

pub fn read_commit(repo: &gix::Repository, id: ObjectId) -> anyhow::Result<(CommitInfo, ObjectId)> {
    let commit = repo
        .find_commit(id)
        .with_context(|| format!("reading commit {id}"))?;
    let c = commit.decode()?;
    let info = CommitInfo {
        id,
        parents: c.parents().collect(),
        author: read_signature(c.author()?),
        committer: read_signature(c.committer()?),
        message: c.message.to_str_lossy().into_owned(),
        shallow_root: false,
    };
    Ok((info, c.tree()))
}

pub struct DiffWorker {
    repo: gix::Repository,
    cache: gix::diff::blob::Platform,
    state: gix::diff::tree::State,
    opts: DiffOptions,
}

/// Lines as git counts them: split after '\n'; a trailing partial line counts.
fn split_lines(data: &[u8]) -> impl Iterator<Item = &[u8]> {
    data.split_inclusive(|&b| b == b'\n')
}

pub fn count_lines(data: &[u8]) -> u32 {
    let n = data.iter().filter(|&&b| b == b'\n').count() as u32;
    n + u32::from(!data.is_empty() && *data.last().unwrap() != b'\n')
}

fn is_binary(data: &[u8]) -> bool {
    data[..data.len().min(8000)].contains(&0)
}

fn hash_ignoring_ws(line: &[u8]) -> u64 {
    let mut h = FxHasher::default();
    for &b in line {
        if !b.is_ascii_whitespace() {
            b.hash(&mut h);
        }
    }
    h.finish()
}

fn hunks_of(diff: &Diff) -> Vec<Hunk> {
    diff.hunks()
        .map(|h| Hunk {
            b0: h.before.start,
            b1: h.before.end,
            a0: h.after.start,
            a1: h.after.end,
        })
        .collect()
}

/// (strict hunks, adds, dels) with the histogram algorithm, like `git diff --histogram`.
fn line_diff(old: &[u8], new: &[u8]) -> (Vec<Hunk>, u32, u32) {
    let input = InternedInput::new(old, new);
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_lines(&input);
    (
        hunks_of(&diff),
        diff.count_additions(),
        diff.count_removals(),
    )
}

/// Same, but lines that differ only in whitespace compare equal (`git diff -w`).
fn ws_diff(old: &[u8], new: &[u8]) -> (Vec<Hunk>, u32, u32) {
    let mut input: InternedInput<u64> = InternedInput::default();
    input.update_before(split_lines(old).map(hash_ignoring_ws));
    input.update_after(split_lines(new).map(hash_ignoring_ws));
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_no_heuristic(&input);
    (
        hunks_of(&diff),
        diff.count_additions(),
        diff.count_removals(),
    )
}

impl DiffWorker {
    pub fn new(repo: gix::Repository, opts: DiffOptions) -> anyhow::Result<Self> {
        let cache = repo.diff_resource_cache_for_tree_diff()?;
        Ok(Self {
            repo,
            cache,
            state: Default::default(),
            opts,
        })
    }

    pub fn repo(&self) -> &gix::Repository {
        &self.repo
    }

    fn blob(&self, id: ObjectId) -> anyhow::Result<Vec<u8>> {
        Ok(self
            .repo
            .find_blob(id)
            .with_context(|| format!("reading blob {id}"))?
            .take_data())
    }

    pub fn run(
        &mut self,
        step: Step,
        id: ObjectId,
        side: Vec<crate::walk::SideCommit>,
    ) -> anyhow::Result<StepDiff> {
        let (mut commit, tree_id) = read_commit(&self.repo, id)?;
        let new_tree = self.repo.find_tree(tree_id)?;
        let old_tree = match commit.parents.first() {
            Some(&p) => match self.repo.find_commit(p) {
                Ok(pc) => Some(pc.tree()?),
                Err(_) => {
                    commit.shallow_root = true;
                    None
                }
            },
            None => None,
        };
        let empty = self.repo.empty_tree();
        let old_tree_owned = old_tree;
        let old_tree = old_tree_owned.as_ref().unwrap_or(&empty);

        let mut changes: Vec<Change> = Vec::new();
        let opts = TreeDiffOptions {
            location: Some(Location::Path),
            rewrites: Some(gix::diff::Rewrites {
                limit: self.opts.rename_limit,
                ..Default::default()
            }),
        };
        gix::diff::tree_with_rewrites(
            TreeRefIter::from_bytes(&old_tree.data, old_tree.id.kind()),
            TreeRefIter::from_bytes(&new_tree.data, new_tree.id.kind()),
            &mut self.cache,
            &mut self.state,
            &self.repo.objects,
            |change| {
                changes.push(change.into_owned());
                Ok(ControlFlow::Continue(()))
            },
            opts,
        )
        .map_err(|e| anyhow::anyhow!("tree diff of {id}: {e}"))?;
        self.cache.clear_resource_cache_keep_allocation();
        drop((new_tree, old_tree_owned, empty));

        let mut files = Vec::with_capacity(changes.len());
        for change in changes {
            if let Some(f) = self.file_diff(change)? {
                files.push(f);
            }
        }
        if self.opts.merge_blame && commit.parents.len() > 1 && !commit.shallow_root {
            self.attribute_merge(&commit, &side, &mut files)?;
        }
        Ok(StepDiff {
            step,
            commit,
            files,
            side,
        })
    }

    /// Every blob change made by the non-merge side commits: path -> [(side index, old blob, new blob)].
    fn side_touches(
        &mut self,
        side: &[crate::walk::SideCommit],
    ) -> anyhow::Result<rustc_hash::FxHashMap<BString, Vec<Touch>>> {
        let mut touched: rustc_hash::FxHashMap<BString, Vec<Touch>> = Default::default();
        for (i, sc) in side.iter().enumerate() {
            if sc.is_merge {
                continue;
            }
            let Ok(new_tree) = self.repo.find_commit(sc.id).and_then(|c| c.tree()) else {
                continue;
            };
            // A root commit (unrelated history) is diffed against the empty tree.
            let old_tree = match sc.first_parent {
                Some(parent) => match self.repo.find_commit(parent).and_then(|c| c.tree()) {
                    Ok(t) => t,
                    Err(_) => continue,
                },
                None => self.repo.empty_tree(),
            };
            let opts = TreeDiffOptions {
                location: Some(Location::Path),
                rewrites: None,
            };
            let mut found: Vec<(BString, Touch)> = Vec::new();
            gix::diff::tree_with_rewrites(
                TreeRefIter::from_bytes(&old_tree.data, old_tree.id.kind()),
                TreeRefIter::from_bytes(&new_tree.data, new_tree.id.kind()),
                &mut self.cache,
                &mut self.state,
                &self.repo.objects,
                |change| {
                    use gix::diff::tree_with_rewrites::ChangeRef as C;
                    let t = match change {
                        C::Addition { entry_mode, id, .. } if entry_mode.is_blob_or_symlink() => {
                            Some((None, Some(id)))
                        }
                        C::Deletion { entry_mode, id, .. } if entry_mode.is_blob_or_symlink() => {
                            Some((Some(id), None))
                        }
                        C::Modification {
                            previous_entry_mode,
                            previous_id,
                            entry_mode,
                            id,
                            ..
                        } if entry_mode.is_blob_or_symlink()
                            && previous_entry_mode.is_blob_or_symlink() =>
                        {
                            Some((Some(previous_id), Some(id)))
                        }
                        _ => None,
                    };
                    if let Some((old, new)) = t {
                        found.push((change.location().to_owned(), Touch { side: i, old, new }));
                    }
                    Ok(ControlFlow::Continue(()))
                },
                opts,
            )
            .map_err(|e| anyhow::anyhow!("tree diff of side commit {}: {e}", sc.id))?;
            for (p, t) in found {
                touched.entry(p).or_default().push(t);
            }
        }
        self.cache.clear_resource_cache_keep_allocation();
        Ok(touched)
    }

    /// In-process blame for the common case: the side commits that touched a file form one
    /// unbroken chain of versions ending in `final_id`. Replays their diffs (whitespace-insensitive,
    /// like `git blame -w`) from the chain's first version, whose lines stay "boundary".
    /// Returns None when the history isn't such a chain (the caller falls back to git blame).
    fn replay_chain(
        &self,
        touches: &[Touch],
        final_id: ObjectId,
    ) -> anyhow::Result<Option<Vec<Option<usize>>>> {
        // Order by content continuity: each touch's old blob is the previous touch's new blob.
        let produced: rustc_hash::FxHashSet<ObjectId> =
            touches.iter().filter_map(|t| t.new).collect();
        let starts: Vec<&Touch> = touches
            .iter()
            .filter(|t| t.old.is_none_or(|o| !produced.contains(&o)))
            .collect();
        if starts.len() != 1 {
            return Ok(None);
        }
        let mut chain = vec![starts[0]];
        while chain.len() < touches.len() {
            let Some(cur) = chain.last().unwrap().new else {
                return Ok(None);
            };
            let next: Vec<&Touch> = touches.iter().filter(|t| t.old == Some(cur)).collect();
            if next.len() != 1 {
                return Ok(None);
            }
            chain.push(next[0]);
        }
        if chain.last().unwrap().new != Some(final_id) {
            return Ok(None);
        }
        // Replay: origin per line (None = older than the side branch).
        let mut origins: Vec<Option<usize>> = match chain[0].old {
            Some(id) => vec![None; count_lines(&self.blob(id)?) as usize],
            None => Vec::new(),
        };
        for t in &chain {
            let old = match t.old {
                Some(id) => self.blob(id)?,
                None => Vec::new(),
            };
            let new = self.blob(t.new.expect("chain links have a new blob"))?;
            if is_binary(&old) || is_binary(&new) {
                return Ok(None);
            }
            let (hunks, _, _) = ws_diff(&old, &new);
            let mut out: Vec<Option<usize>> = Vec::with_capacity(count_lines(&new) as usize);
            let mut pos = 0usize;
            for h in &hunks {
                out.extend_from_slice(origins.get(pos..h.b0 as usize).unwrap_or_default());
                out.extend(std::iter::repeat_n(Some(t.side), (h.a1 - h.a0) as usize));
                pos = h.b1 as usize;
            }
            out.extend_from_slice(origins.get(pos..).unwrap_or_default());
            origins = out;
        }
        Ok(Some(origins))
    }

    /// Per-line origins -> runs.
    fn to_runs(
        origins: &[Option<usize>],
        side: &[crate::walk::SideCommit],
    ) -> Vec<crate::blame::BlameRun> {
        let mut runs: Vec<crate::blame::BlameRun> = Vec::new();
        for (line, o) in origins.iter().enumerate() {
            match runs.last_mut() {
                Some(r)
                    if r.start + r.len == line as u32
                        && r.origin.as_ref().map(|x| x.sha) == o.map(|i| side[i].id) =>
                {
                    r.len += 1
                }
                _ => runs.push(crate::blame::BlameRun {
                    start: line as u32,
                    len: 1,
                    origin: o.map(|i| crate::blame::BlameOrigin {
                        sha: side[i].id,
                        name: side[i].author.name.clone(),
                        email: side[i].author.email.clone(),
                        time: side[i].author.time,
                    }),
                }),
            }
        }
        runs
    }

    /// Origins for the merged file: replay the side chain to the side parent's version of the
    /// file, then carry origins across the (side version -> merged version) diff. Lines the merge
    /// itself introduced come back as None (credited to the merge).
    fn replay_through_side(
        &self,
        touches: &[Touch],
        merged_id: ObjectId,
        path: &BString,
        side_trees: &[ObjectId],
    ) -> anyhow::Result<Option<Vec<Option<usize>>>> {
        for tree_id in side_trees {
            let Ok(tree) = self.repo.find_tree(*tree_id) else {
                continue;
            };
            let Some(entry) = tree
                .lookup_entry_by_path(path.to_os_str_lossy().as_ref() as &std::ffi::OsStr)
                .ok()
                .flatten()
            else {
                continue;
            };
            let side_id = entry.object_id();
            let Some(origins) = self.replay_chain(touches, side_id)? else {
                continue;
            };
            if side_id == merged_id {
                return Ok(Some(origins));
            }
            let side_blob = self.blob(side_id)?;
            let merged = self.blob(merged_id)?;
            if is_binary(&side_blob) || is_binary(&merged) {
                return Ok(None);
            }
            let (hunks, _, _) = ws_diff(&side_blob, &merged);
            let mut out: Vec<Option<usize>> = Vec::with_capacity(count_lines(&merged) as usize);
            let mut pos = 0usize;
            for h in &hunks {
                out.extend_from_slice(origins.get(pos..h.b0 as usize).unwrap_or_default());
                out.extend(std::iter::repeat_n(None, (h.a1 - h.a0) as usize));
                pos = h.b1 as usize;
            }
            out.extend_from_slice(origins.get(pos..).unwrap_or_default());
            return Ok(Some(out));
        }
        Ok(None)
    }

    /// Credit the lines a merge adds (vs its first parent) to the side commits that wrote them:
    /// replay the side branch's edits in-process when they form a simple chain, else `git blame`.
    fn attribute_merge(
        &mut self,
        commit: &CommitInfo,
        side: &[crate::walk::SideCommit],
        files: &mut [FileDiff],
    ) -> anyhow::Result<()> {
        let added: u64 = files
            .iter()
            .filter(|f| !f.binary && !f.submodule)
            .flat_map(|f| f.hunks.iter())
            .map(|h| u64::from(h.a1 - h.a0))
            .sum();
        if added == 0 || added > u64::from(self.opts.blame_max_lines) {
            return Ok(());
        }
        let touched = self.side_touches(side)?;
        let git_dir = self.repo.path().to_path_buf();
        let side_trees: Vec<ObjectId> = commit.parents[1..]
            .iter()
            .filter_map(|p| Some(self.repo.find_commit(*p).ok()?.tree_id().ok()?.detach()))
            .collect();
        for f in files.iter_mut() {
            if f.binary || f.submodule || f.approx || !f.hunks.iter().any(|h| h.a1 > h.a0) {
                continue;
            }
            let touches = if f.kind == crate::model::kind::RENAME {
                None
            } else {
                touched.get(&f.path)
            };
            let replayed = match (touches, f.new_id) {
                (Some(t), Some(merged_id)) => self
                    .replay_through_side(t, merged_id, &f.path, &side_trees)?
                    .map(|o| Self::to_runs(&o, side)),
                _ => None,
            };
            match (replayed, touches) {
                (Some(runs), _) => {
                    crate::blame::BLAME_SHORTCUTS
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    f.blame = Some(runs);
                }
                // No side commit changed it: the merge itself wrote these lines.
                (None, None) if f.kind != crate::model::kind::RENAME => {}
                _ => match crate::blame::blame_added(
                    &git_dir,
                    commit.id,
                    commit.parents[0],
                    &f.path,
                    &f.hunks,
                ) {
                    Ok(runs) => f.blame = Some(runs),
                    Err(e) => tracing::debug!("merge blame fell back to the merger: {e:#}"),
                },
            }
        }
        Ok(())
    }

    fn file_diff(&self, change: Change) -> anyhow::Result<Option<FileDiff>> {
        use gix::objs::tree::EntryMode;
        let content = |mode: EntryMode, id: ObjectId| -> anyhow::Result<Option<Vec<u8>>> {
            Ok(if mode.is_blob_or_symlink() {
                Some(self.blob(id)?)
            } else {
                None
            })
        };
        let new_id = match &change {
            Change::Addition { id, .. }
            | Change::Modification { id, .. }
            | Change::Rewrite { id, .. } => Some(*id),
            Change::Deletion { .. } => None,
        };
        let (path, old_path, kind, old, new, submodule) = match change {
            Change::Addition {
                location,
                entry_mode,
                id,
                ..
            } => {
                if entry_mode.is_tree() {
                    return Ok(None);
                }
                (
                    location,
                    None,
                    kind::ADD,
                    None,
                    content(entry_mode, id)?,
                    entry_mode.is_commit(),
                )
            }
            Change::Deletion {
                location,
                entry_mode,
                id,
                ..
            } => {
                if entry_mode.is_tree() {
                    return Ok(None);
                }
                (
                    location,
                    None,
                    kind::DELETE,
                    content(entry_mode, id)?,
                    None,
                    entry_mode.is_commit(),
                )
            }
            Change::Modification {
                location,
                previous_entry_mode,
                previous_id,
                entry_mode,
                id,
            } => {
                if entry_mode.is_tree() && previous_entry_mode.is_tree() {
                    return Ok(None);
                }
                let old = if previous_entry_mode.is_tree() {
                    None
                } else {
                    content(previous_entry_mode, previous_id)?
                };
                let new = if entry_mode.is_tree() {
                    None
                } else {
                    content(entry_mode, id)?
                };
                (
                    location,
                    None,
                    kind::MODIFY,
                    old,
                    new,
                    entry_mode.is_commit(),
                )
            }
            Change::Rewrite {
                source_location,
                source_entry_mode,
                source_id,
                entry_mode,
                id,
                location,
                ..
            } => {
                if entry_mode.is_tree() {
                    return Ok(None);
                }
                let old = content(source_entry_mode, source_id)?;
                (
                    location,
                    Some(source_location),
                    kind::RENAME,
                    old,
                    content(entry_mode, id)?,
                    entry_mode.is_commit(),
                )
            }
        };

        let mut f = FileDiff {
            path,
            old_path,
            kind,
            submodule,
            new_id,
            ..Default::default()
        };
        let old_bytes = old.as_deref().unwrap_or_default();
        let new_bytes = new.as_deref().unwrap_or_default();
        f.bytes_after = new_bytes.len() as u64;
        if submodule {
            return Ok(Some(f));
        }
        if is_binary(old_bytes) || is_binary(new_bytes) {
            // Like `git diff --numstat`, binary changes count no lines; a text file that became
            // binary (or vice versa) still loses (gains) its lines in the tracker.
            f.binary = is_binary(new_bytes);
            f.old_lines = if is_binary(old_bytes) {
                0
            } else {
                count_lines(old_bytes)
            };
            if !f.binary && !new_bytes.is_empty() {
                f.new_lines = count_lines(new_bytes);
                f.hunks = vec![Hunk {
                    b0: 0,
                    b1: 0,
                    a0: 0,
                    a1: f.new_lines,
                }];
            }
            return Ok(Some(f));
        }
        f.generated_hint = kind != kind::DELETE && looks_generated(new_bytes);
        f.old_lines = count_lines(old_bytes);
        f.new_lines = count_lines(new_bytes);

        let too_big = old_bytes.len().max(new_bytes.len()) as u64 > self.opts.max_diff_bytes;
        if too_big {
            f.approx = true;
            let (o, n) = (f.old_lines, f.new_lines);
            f.adds = n.saturating_sub(o);
            f.dels = o.saturating_sub(n);
            f.adds_ws = f.adds;
            f.dels_ws = f.dels;
            let common = o.min(n);
            f.hunks = if o == n {
                vec![]
            } else {
                vec![Hunk {
                    b0: common,
                    b1: o,
                    a0: common,
                    a1: n,
                }]
            };
            return Ok(Some(f));
        }
        if old_bytes == new_bytes {
            return Ok(Some(f));
        }
        let (strict, adds, dels) = line_diff(old_bytes, new_bytes);
        let (ws, adds_ws, dels_ws) = ws_diff(old_bytes, new_bytes);
        f.adds = adds;
        f.dels = dels;
        f.adds_ws = adds_ws;
        f.dels_ws = dels_ws;
        f.hunks = if self.opts.survival_ws_ignore {
            ws
        } else {
            strict
        };
        Ok(Some(f))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_counting_matches_git() {
        assert_eq!(count_lines(b""), 0);
        assert_eq!(count_lines(b"a"), 1);
        assert_eq!(count_lines(b"a\n"), 1);
        assert_eq!(count_lines(b"a\nb"), 2);
        assert_eq!(count_lines(b"\n\n"), 2);
    }

    #[test]
    fn whitespace_insensitive_diff() {
        let old = b"fn a() {\n  x();\n}\n";
        let new = b"fn a() {\n    x();\n}\n";
        let (_, adds, dels) = line_diff(old, new);
        assert_eq!((adds, dels), (1, 1));
        let (hunks, adds, dels) = ws_diff(old, new);
        assert_eq!((adds, dels), (0, 0));
        assert!(hunks.is_empty());
    }
}
