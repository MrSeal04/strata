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
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self { max_diff_bytes: 16 << 20, survival_ws_ignore: true, rename_limit: 1000 }
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
}

#[derive(Debug)]
pub struct StepDiff {
    pub step: Step,
    pub commit: CommitInfo,
    pub files: Vec<FileDiff>,
}

pub fn read_signature(sig: gix::actor::SignatureRef<'_>) -> Signature {
    Signature {
        name: sig.name.into(),
        email: sig.email.into(),
        time: sig.time().map(|t| t.seconds).unwrap_or(0),
    }
}

pub fn read_commit(repo: &gix::Repository, id: ObjectId) -> anyhow::Result<(CommitInfo, ObjectId)> {
    let commit = repo.find_commit(id).with_context(|| format!("reading commit {id}"))?;
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
        .map(|h| Hunk { b0: h.before.start, b1: h.before.end, a0: h.after.start, a1: h.after.end })
        .collect()
}

/// (strict hunks, adds, dels) with the histogram algorithm, like `git diff --histogram`.
fn line_diff(old: &[u8], new: &[u8]) -> (Vec<Hunk>, u32, u32) {
    let input = InternedInput::new(old, new);
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_lines(&input);
    (hunks_of(&diff), diff.count_additions(), diff.count_removals())
}

/// Same, but lines that differ only in whitespace compare equal (`git diff -w`).
fn ws_diff(old: &[u8], new: &[u8]) -> (Vec<Hunk>, u32, u32) {
    let mut input: InternedInput<u64> = InternedInput::default();
    input.update_before(split_lines(old).map(hash_ignoring_ws));
    input.update_after(split_lines(new).map(hash_ignoring_ws));
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_no_heuristic(&input);
    (hunks_of(&diff), diff.count_additions(), diff.count_removals())
}

impl DiffWorker {
    pub fn new(repo: gix::Repository, opts: DiffOptions) -> anyhow::Result<Self> {
        let cache = repo.diff_resource_cache_for_tree_diff()?;
        Ok(Self { repo, cache, state: Default::default(), opts })
    }

    pub fn repo(&self) -> &gix::Repository {
        &self.repo
    }

    fn blob(&self, id: ObjectId) -> anyhow::Result<Vec<u8>> {
        Ok(self.repo.find_blob(id).with_context(|| format!("reading blob {id}"))?.take_data())
    }

    pub fn run(&mut self, step: Step, id: ObjectId) -> anyhow::Result<StepDiff> {
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
        let old_tree = old_tree.as_ref().unwrap_or(&empty);

        let mut changes: Vec<Change> = Vec::new();
        let opts = TreeDiffOptions {
            location: Some(Location::Path),
            rewrites: Some(gix::diff::Rewrites { limit: self.opts.rename_limit, ..Default::default() }),
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

        let mut files = Vec::with_capacity(changes.len());
        for change in changes {
            if let Some(f) = self.file_diff(change)? {
                files.push(f);
            }
        }
        Ok(StepDiff { step, commit, files })
    }

    fn file_diff(&self, change: Change) -> anyhow::Result<Option<FileDiff>> {
        use gix::objs::tree::EntryMode;
        let content = |mode: EntryMode, id: ObjectId| -> anyhow::Result<Option<Vec<u8>>> {
            Ok(if mode.is_blob_or_symlink() { Some(self.blob(id)?) } else { None })
        };
        let (path, old_path, kind, old, new, submodule) = match change {
            Change::Addition { location, entry_mode, id, .. } => {
                if entry_mode.is_tree() {
                    return Ok(None);
                }
                (location, None, kind::ADD, None, content(entry_mode, id)?, entry_mode.is_commit())
            }
            Change::Deletion { location, entry_mode, id, .. } => {
                if entry_mode.is_tree() {
                    return Ok(None);
                }
                (location, None, kind::DELETE, content(entry_mode, id)?, None, entry_mode.is_commit())
            }
            Change::Modification { location, previous_entry_mode, previous_id, entry_mode, id } => {
                if entry_mode.is_tree() && previous_entry_mode.is_tree() {
                    return Ok(None);
                }
                let old = if previous_entry_mode.is_tree() { None } else { content(previous_entry_mode, previous_id)? };
                let new = if entry_mode.is_tree() { None } else { content(entry_mode, id)? };
                (location, None, kind::MODIFY, old, new, entry_mode.is_commit())
            }
            Change::Rewrite { source_location, source_entry_mode, source_id, entry_mode, id, location, .. } => {
                if entry_mode.is_tree() {
                    return Ok(None);
                }
                let old = content(source_entry_mode, source_id)?;
                (location, Some(source_location), kind::RENAME, old, content(entry_mode, id)?, entry_mode.is_commit())
            }
        };

        let mut f = FileDiff { path, old_path, kind, submodule, ..Default::default() };
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
            f.old_lines = if is_binary(old_bytes) { 0 } else { count_lines(old_bytes) };
            if !f.binary && !new_bytes.is_empty() {
                f.new_lines = count_lines(new_bytes);
                f.hunks = vec![Hunk { b0: 0, b1: 0, a0: 0, a1: f.new_lines }];
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
            f.hunks = if o == n { vec![] } else { vec![Hunk { b0: common, b1: o, a0: common, a1: n }] };
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
        f.hunks = if self.opts.survival_ws_ignore { ws } else { strict };
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
