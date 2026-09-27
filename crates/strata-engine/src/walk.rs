//! History walking: the first-parent chain, landing steps for side-branch commits, and tags.

use anyhow::{Context, bail};
use bstr::ByteSlice;
use gix::ObjectId;
use rustc_hash::FxHashMap;

use crate::diff::{Signature, read_signature};
use crate::model::Step;

/// Resolve the branch to analyze: an explicit name (local, then `origin/`), else HEAD.
pub fn resolve_tip(
    repo: &gix::Repository,
    branch: Option<&str>,
) -> anyhow::Result<(String, ObjectId)> {
    if let Some(b) = branch {
        for candidate in [
            format!("refs/heads/{b}"),
            format!("refs/remotes/origin/{b}"),
            b.to_string(),
        ] {
            if let Ok(id) = repo.rev_parse_single(candidate.as_str()) {
                let id = id.object()?.peel_to_commit()?.id;
                return Ok((b.to_string(), id));
            }
        }
        bail!("branch '{b}' not found");
    }
    let name = repo
        .head_name()?
        .map(|n| n.shorten().to_str_lossy().into_owned())
        .unwrap_or_else(|| "HEAD".into());
    let id = repo
        .head_commit()
        .context("repository has no commits on HEAD")?
        .id;
    Ok((name, id))
}

pub struct Chain {
    /// Commits oldest-first. When resuming, only those after `stop`.
    pub ids: Vec<ObjectId>,
    /// `stop` was found on the chain, so `ids` extends the previous run.
    pub resumed: bool,
}

/// Walk first parents from `tip`. If `stop` is met, return only the commits after it.
pub fn first_parent_chain(
    repo: &gix::Repository,
    tip: ObjectId,
    stop: Option<ObjectId>,
) -> anyhow::Result<Chain> {
    let mut ids = Vec::new();
    let mut cur = Some(tip);
    let mut resumed = false;
    while let Some(id) = cur {
        if Some(id) == stop {
            resumed = true;
            break;
        }
        ids.push(id);
        cur = match repo.find_commit(id) {
            Ok(c) => c.parent_ids().next().map(|p| p.detach()),
            Err(_) => None, // shallow boundary
        };
    }
    ids.reverse();
    Ok(Chain { ids, resumed })
}

#[derive(Clone, Debug)]
pub struct SideCommit {
    pub id: ObjectId,
    pub author: Signature,
    pub summary: String,
    pub first_parent: Option<ObjectId>,
    pub is_merge: bool,
}

/// Maps every commit in the analyzed history to the first-parent step that landed it.
#[derive(Default)]
pub struct Landing {
    /// commit -> (landing step, is a first-parent chain commit)
    map: FxHashMap<ObjectId, (Step, bool)>,
}

impl Landing {
    pub fn step_of(&self, id: &ObjectId) -> Option<Step> {
        self.map.get(id).map(|e| e.0)
    }

    pub fn on_main(&self, id: &ObjectId) -> bool {
        self.map.get(id).is_some_and(|e| e.1)
    }

    /// Serializable form, keeping only commits landed before `until` (for checkpoints).
    pub fn to_rows(&self, until: Step) -> Vec<(Vec<u8>, Step, bool)> {
        self.map
            .iter()
            .filter(|(_, (s, _))| *s < until)
            .map(|(id, (s, main))| (id.as_bytes().to_vec(), *s, *main))
            .collect()
    }

    pub fn from_rows(rows: Vec<(Vec<u8>, Step, bool)>) -> Self {
        let map = rows
            .into_iter()
            .filter_map(|(b, s, m)| Some((ObjectId::try_from(b.as_slice()).ok()?, (s, m))))
            .collect();
        Self { map }
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Record chain commit `id` at `step` and collect the side commits its extra parents bring in.
    pub fn land(
        &mut self,
        repo: &gix::Repository,
        step: Step,
        id: ObjectId,
        extra_parents: &[ObjectId],
        with_meta: bool,
    ) -> anyhow::Result<Vec<SideCommit>> {
        self.map.insert(id, (step, true));
        let mut side = Vec::new();
        let mut stack: Vec<ObjectId> = extra_parents.to_vec();
        while let Some(cid) = stack.pop() {
            if self.map.contains_key(&cid) {
                continue;
            }
            let Ok(commit) = repo.find_commit(cid) else {
                continue;
            };
            self.map.insert(cid, (step, false));
            let c = commit.decode()?;
            let parents: Vec<ObjectId> = c.parents().collect();
            stack.extend(parents.iter().copied());
            if with_meta {
                side.push(SideCommit {
                    id: cid,
                    first_parent: parents.first().copied(),
                    is_merge: parents.len() > 1,
                    author: read_signature(c.author()?),
                    summary: c
                        .message
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .to_str_lossy()
                        .into_owned(),
                });
            }
        }
        Ok(side)
    }
}

#[derive(Clone, Debug)]
pub struct Tag {
    pub name: String,
    pub commit: ObjectId,
    pub time: i64,
}

pub fn tags(repo: &gix::Repository) -> anyhow::Result<Vec<Tag>> {
    let mut out = Vec::new();
    for r in repo.references()?.tags()? {
        let Ok(mut r) = r else { continue };
        let name = r.name().shorten().to_str_lossy().into_owned();
        let Ok(commit) = r.peel_to_kind(gix::object::Kind::Commit) else {
            continue;
        };
        let commit = commit.into_commit();
        let time = commit.time().map(|t| t.seconds).unwrap_or(0);
        out.push(Tag {
            name,
            commit: commit.id,
            time,
        });
    }
    Ok(out)
}

/// `.gitattributes` files in `tree`: (directory prefix like "" or "a/b/", content), shallowest first.
pub fn attribute_files(
    repo: &gix::Repository,
    tree: ObjectId,
) -> anyhow::Result<Vec<(String, Vec<u8>)>> {
    let mut rec = gix::traverse::tree::Recorder::default();
    repo.find_tree(tree)?.traverse().breadthfirst(&mut rec)?;
    let mut out = Vec::new();
    for e in rec.records {
        let path = e.filepath.to_str_lossy();
        let (dir, file) = match path.rfind('/') {
            Some(i) => (&path[..=i], &path[i + 1..]),
            None => ("", &*path),
        };
        if file == ".gitattributes" && e.mode.is_blob() {
            out.push((dir.to_string(), repo.find_blob(e.oid)?.take_data()));
        }
    }
    out.sort_by_key(|(d, _)| d.matches('/').count());
    Ok(out)
}
