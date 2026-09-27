//! Row types the engine emits. `strata-store` turns them into Parquet tables.

use serde::{Deserialize, Serialize};

/// Index of a commit along the first-parent chain, oldest = 0.
pub type Step = u32;
/// Interned repository path, stable across incremental runs.
pub type PathId = u32;
/// Raw identity (one per distinct mailmapped name+email). `AuthorRow::canonical_id` merges aliases.
pub type AuthorId = u32;

pub const NO_PATH: PathId = u32::MAX;

/// `ChangeRow::kind` values.
pub mod kind {
    pub const ADD: u8 = 0;
    pub const MODIFY: u8 = 1;
    pub const DELETE: u8 = 2;
    /// Destination of a rename (carries the line counts).
    pub const RENAME: u8 = 3;
    /// Source of a rename: the path stops existing, but its lines moved, so adds/dels are 0.
    pub const RENAME_SOURCE: u8 = 4;
}

/// `StepRow::flags` bits.
pub mod step_flags {
    /// The first step of a history (or of a shallow clone): everything arrives at once.
    pub const IMPORT: u8 = 1;
    /// Some file in this step was too large to diff; counts are line-count deltas.
    pub const APPROX: u8 = 2;
    /// The first step's parent is missing because the clone is shallow.
    pub const SHALLOW_ROOT: u8 = 4;
}

/// Path categories, stored per path and filtered at query time.
pub mod category {
    pub const SOURCE: u8 = 0;
    pub const DOCS: u8 = 1;
    pub const DATA: u8 = 2;
    pub const NOTEBOOK: u8 = 3;
    pub const LOCKFILE: u8 = 4;
    pub const VENDORED: u8 = 5;
    pub const GENERATED: u8 = 6;
    pub const BINARY: u8 = 7;
    pub const SUBMODULE: u8 = 8;
    pub const NAMES: [&str; 9] = [
        "source",
        "docs",
        "data",
        "notebook",
        "lockfile",
        "vendored",
        "generated",
        "binary",
        "submodule",
    ];
}

#[derive(Clone, Debug, Default)]
pub struct StepRow {
    pub step: Step,
    pub sha: String,
    pub author_id: AuthorId,
    pub committer_id: AuthorId,
    pub author_time: i64,
    pub commit_time: i64,
    /// Committer time made monotonic along the chain (running max); the calendar axis uses this.
    pub axis_time: i64,
    pub is_merge: bool,
    pub side_count: u32,
    pub summary: String,
    pub message: String,
    pub adds: u32,
    pub dels: u32,
    pub adds_ws: u32,
    pub dels_ws: u32,
    pub files_changed: u32,
    pub flags: u8,
}

#[derive(Clone, Debug, Default)]
pub struct ChangeRow {
    pub step: Step,
    pub path_id: PathId,
    pub kind: u8,
    pub old_path_id: PathId,
    pub adds: u32,
    pub dels: u32,
    pub adds_ws: u32,
    pub dels_ws: u32,
    pub lines_after: u32,
    /// `lines_after` minus the path's lines before this change. Cumulative sums give repo size
    /// (unlike adds - dels, this also covers binary<->text flips and oversize approximations).
    pub line_delta: i32,
    pub bytes_after: u64,
    /// Mean author time of the file's surviving lines after this change (0 if empty/binary).
    pub mean_origin_time: i64,
    pub top_author: AuthorId,
    pub top_share: f32,
    pub binary: bool,
    pub approx: bool,
}

/// Lines entering (+) or leaving (-) the repo at `step` in `path_id`, bucketed by the month the
/// line was originally written and by its original author. Cumulative sums give survival layers.
#[derive(Clone, Debug)]
pub struct OriginDeltaRow {
    pub step: Step,
    pub path_id: PathId,
    /// Months since 1970-01.
    pub cohort: u16,
    pub author_id: AuthorId,
    pub delta: i32,
}

/// Full per-file state at `kf_step`, so any step's state = nearest keyframe + later changes.
#[derive(Clone, Debug)]
pub struct KeyframeRow {
    pub kf_step: Step,
    pub path_id: PathId,
    pub lines: u32,
    pub bytes: u64,
    pub mean_origin_time: i64,
    pub top_author: AuthorId,
    pub top_share: f32,
    pub binary: bool,
}

/// A commit a merge step brought in from its non-first parents.
#[derive(Clone, Debug)]
pub struct SideCommitRow {
    pub sha: String,
    pub landing_step: Step,
    pub author_id: AuthorId,
    pub author_time: i64,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PathRow {
    pub path_id: PathId,
    pub path: String,
    pub lang: String,
    pub category: u8,
    pub first_step: Step,
    pub last_step: Step,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthorRow {
    pub author_id: AuthorId,
    pub canonical_id: AuthorId,
    pub name: String,
    pub email: String,
    pub is_bot: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TagRow {
    pub name: String,
    pub sha: String,
    pub step: Step,
    pub time: i64,
    /// False when the tag points at a side-branch commit (step = the merge that landed it).
    pub on_main: bool,
}

/// Everything the engine produces for one step, handed to the sink in step order.
#[derive(Debug, Default)]
pub struct StepOutput {
    pub step: StepRow,
    pub changes: Vec<ChangeRow>,
    pub deltas: Vec<OriginDeltaRow>,
    pub side_commits: Vec<SideCommitRow>,
}

/// Small dimension tables, rewritten in full at the end of every run.
#[derive(Debug, Default)]
pub struct Dimensions {
    pub paths: Vec<PathRow>,
    pub authors: Vec<AuthorRow>,
    pub tags: Vec<TagRow>,
}

/// Where extraction output goes. Implemented by `strata-store`.
pub trait Sink {
    /// Called once before any rows: output for steps >= `from_step` must be discarded
    /// (0 = start over; otherwise these are leftovers of an interrupted run).
    fn begin(&mut self, from_step: Step) -> anyhow::Result<()>;
    fn write_step(&mut self, out: StepOutput) -> anyhow::Result<()>;
    fn write_keyframe(&mut self, step: Step, rows: Vec<KeyframeRow>) -> anyhow::Result<()>;
    /// Make everything written so far durable (called right before a checkpoint is saved).
    fn flush(&mut self) -> anyhow::Result<()>;
    fn finish(&mut self, dims: Dimensions) -> anyhow::Result<()>;
}
