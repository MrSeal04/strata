//! Line-origin tracker: for every live file, a run-length-encoded list of which origin (commit
//! time + author) wrote each line. Applying a diff splices runs, so the origin of every removed
//! line is known at removal and survival is exact at O(changed lines) per step.

use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;

use crate::model::{AuthorId, KeyframeRow, OriginDeltaRow, PathId, Step};
use crate::time::month_index;

pub type OriginId = u32;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Origin {
    pub time: i64,
    pub author: AuthorId,
    pub month: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    pub origin: OriginId,
    pub len: u32,
}

/// A contiguous edit: old lines `[b0, b1)` replaced by new lines `[a0, a1)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub b0: u32,
    pub b1: u32,
    pub a0: u32,
    pub a1: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FileState {
    pub lines: u32,
    pub bytes: u64,
    pub binary: bool,
    runs: Vec<Run>,
    /// Sum over lines of origin time (for the mean line age).
    sum_time: i64,
    /// Lines per original author.
    authors: SmallVec<[(AuthorId, u32); 4]>,
}

impl FileState {
    pub fn mean_origin_time(&self) -> i64 {
        if self.lines == 0 {
            0
        } else {
            self.sum_time / i64::from(self.lines)
        }
    }

    /// (top author, share of lines). Share is 0 for empty files.
    pub fn top_author(&self) -> (AuthorId, f32) {
        match self
            .authors
            .iter()
            .max_by_key(|(a, n)| (*n, std::cmp::Reverse(*a)))
        {
            Some(&(a, n)) if self.lines > 0 => (a, n as f32 / self.lines as f32),
            _ => (u32::MAX, 0.0),
        }
    }

    pub fn runs(&self) -> &[Run] {
        &self.runs
    }
}

/// Per (cohort month, author) line deltas for one path within one step.
#[derive(Default)]
pub struct DeltaAcc {
    map: FxHashMap<(u16, AuthorId), i32>,
}

impl DeltaAcc {
    fn add(&mut self, o: &Origin, n: i32) {
        *self.map.entry((o.month, o.author)).or_insert(0) += n;
    }

    pub fn drain_into(&mut self, step: Step, path_id: PathId, out: &mut Vec<OriginDeltaRow>) {
        let mut rows: Vec<_> = self.map.drain().filter(|(_, d)| *d != 0).collect();
        rows.sort_unstable_by_key(|((m, a), _)| (*m, *a));
        out.extend(
            rows.into_iter()
                .map(|((cohort, author_id), delta)| OriginDeltaRow {
                    step,
                    path_id,
                    cohort,
                    author_id,
                    delta,
                }),
        );
    }
}

#[derive(Default, Serialize, Deserialize)]
pub struct Tracker {
    files: FxHashMap<PathId, FileState>,
    origins: Vec<Origin>,
}

impl FileState {
    fn account(&mut self, origins: &[Origin], run: Run, sign: i32, acc: &mut DeltaAcc) {
        let o = &origins[run.origin as usize];
        let n = run.len;
        acc.add(o, sign * n as i32);
        if sign > 0 {
            self.sum_time += o.time * i64::from(n);
            match self.authors.iter_mut().find(|(a, _)| *a == o.author) {
                Some((_, c)) => *c += n,
                None => self.authors.push((o.author, n)),
            }
        } else {
            self.sum_time -= o.time * i64::from(n);
            if let Some(i) = self.authors.iter().position(|(a, _)| *a == o.author) {
                self.authors[i].1 = self.authors[i].1.saturating_sub(n);
                if self.authors[i].1 == 0 {
                    self.authors.swap_remove(i);
                }
            }
        }
    }
}

fn push_run(out: &mut Vec<Run>, run: Run) {
    if run.len == 0 {
        return;
    }
    match out.last_mut() {
        Some(last) if last.origin == run.origin => last.len += run.len,
        _ => out.push(run),
    }
}

impl Tracker {
    pub fn new_origin(&mut self, time: i64, author: AuthorId) -> OriginId {
        self.origins.push(Origin {
            time,
            author,
            month: month_index(time),
        });
        (self.origins.len() - 1) as OriginId
    }

    pub fn origin(&self, id: OriginId) -> &Origin {
        &self.origins[id as usize]
    }

    pub fn get(&self, path: PathId) -> Option<&FileState> {
        self.files.get(&path)
    }

    pub fn live_files(&self) -> usize {
        self.files.len()
    }

    /// Remove a file entirely (deletion); all its lines leave the repo.
    pub fn delete(&mut self, path: PathId, acc: &mut DeltaAcc) {
        if let Some(mut st) = self.files.remove(&path) {
            let runs = std::mem::take(&mut st.runs);
            for run in runs {
                st.account(&self.origins, run, -1, acc);
            }
        }
    }

    /// Detach a file's state without accounting (rename source; the lines move, they don't die).
    pub fn take(&mut self, path: PathId) -> Option<FileState> {
        self.files.remove(&path)
    }

    /// Add `sign` × the file's line composition to `acc` (moving lines between paths on rename).
    pub fn account_all(&self, st: &FileState, sign: i32, acc: &mut DeltaAcc) {
        for r in &st.runs {
            acc.add(&self.origins[r.origin as usize], sign * r.len as i32);
        }
    }

    pub fn put(&mut self, path: PathId, state: FileState) {
        self.files.insert(path, state);
    }

    /// Apply `hunks` (sorted, non-overlapping, in old coordinates) to `path`'s current state.
    /// `origin_of(new_line_index)` gives the origin for each inserted line.
    /// Returns false if the old state disagreed with the hunks (the state is then rebuilt).
    pub fn apply(
        &mut self,
        path: PathId,
        hunks: &[Hunk],
        new_lines: u32,
        bytes: u64,
        origin_of: &dyn Fn(u32) -> OriginId,
        acc: &mut DeltaAcc,
    ) -> bool {
        let mut st = self.files.remove(&path).unwrap_or_default();
        if st.binary {
            // Binary -> text: nothing to splice, every line is new.
            st = FileState::default();
        }
        let old_runs = std::mem::take(&mut st.runs);
        let old_total: u32 = old_runs.iter().map(|r| r.len).sum();
        let net_removed: i64 = hunks
            .iter()
            .map(|h| i64::from(h.b1 - h.b0) - i64::from(h.a1 - h.a0))
            .sum();
        let consistent = i64::from(old_total) - net_removed == i64::from(new_lines)
            && hunks.last().is_none_or(|h| h.b1 <= old_total);

        if !consistent {
            // Unknown or out-of-sync file: drop what we had, treat the whole content as new.
            for run in old_runs {
                st.account(&self.origins, run, -1, acc);
            }
            let whole = [Hunk {
                b0: 0,
                b1: 0,
                a0: 0,
                a1: new_lines,
            }];
            self.splice(&mut st, &[], &whole, origin_of, acc);
        } else {
            self.splice(&mut st, &old_runs, hunks, origin_of, acc);
        }
        st.lines = new_lines;
        st.bytes = bytes;
        st.binary = false;
        debug_assert_eq!(st.runs.iter().map(|r| r.len).sum::<u32>(), new_lines);
        self.files.insert(path, st);
        consistent
    }

    fn splice(
        &self,
        st: &mut FileState,
        old: &[Run],
        hunks: &[Hunk],
        origin_of: &dyn Fn(u32) -> OriginId,
        acc: &mut DeltaAcc,
    ) {
        let mut out: Vec<Run> = Vec::with_capacity(old.len() + hunks.len() * 2);
        // Cursor into old runs: run index + offset within that run.
        let (mut ri, mut off) = (0usize, 0u32);
        let mut pos = 0u32; // old line index at the cursor

        // Consume `n` old lines from the cursor; keep them (copy) or drop them (account -1).
        let mut consume = |n: u32,
                           keep: bool,
                           out: &mut Vec<Run>,
                           st: &mut FileState,
                           ri: &mut usize,
                           off: &mut u32| {
            let mut left = n;
            while left > 0 {
                let run = old[*ri];
                let take = (run.len - *off).min(left);
                let piece = Run {
                    origin: run.origin,
                    len: take,
                };
                if keep {
                    push_run(out, piece);
                } else {
                    st.account(&self.origins, piece, -1, acc);
                }
                *off += take;
                left -= take;
                if *off == run.len {
                    *ri += 1;
                    *off = 0;
                }
            }
        };

        let mut inserts: Vec<Run> = Vec::new();
        for h in hunks {
            consume(h.b0 - pos, true, &mut out, st, &mut ri, &mut off);
            consume(h.b1 - h.b0, false, &mut out, st, &mut ri, &mut off);
            pos = h.b1;
            inserts.clear();
            for line in h.a0..h.a1 {
                push_run(
                    &mut inserts,
                    Run {
                        origin: origin_of(line),
                        len: 1,
                    },
                );
            }
            for &run in &inserts {
                push_run(&mut out, run);
            }
        }
        let rest: u32 = old.iter().map(|r| r.len).sum::<u32>() - pos;
        consume(rest, true, &mut out, st, &mut ri, &mut off);

        // Account insertions after the closure's borrows end.
        for h in hunks {
            let mut piece: Option<Run> = None;
            for line in h.a0..h.a1 {
                let o = origin_of(line);
                match piece.as_mut() {
                    Some(p) if p.origin == o => p.len += 1,
                    _ => {
                        if let Some(p) = piece.take() {
                            st.account(&self.origins, p, 1, acc);
                        }
                        piece = Some(Run { origin: o, len: 1 });
                    }
                }
            }
            if let Some(p) = piece {
                st.account(&self.origins, p, 1, acc);
            }
        }
        st.runs = out;
    }

    /// Record a binary file (no line tracking; any previous text lines leave the repo).
    pub fn set_binary(&mut self, path: PathId, bytes: u64, acc: &mut DeltaAcc) {
        self.delete(path, acc);
        self.files.insert(
            path,
            FileState {
                bytes,
                binary: true,
                ..Default::default()
            },
        );
    }

    pub fn keyframe(&self, step: Step) -> Vec<KeyframeRow> {
        let mut rows: Vec<KeyframeRow> = self
            .files
            .iter()
            .map(|(&path_id, st)| {
                let (top_author, top_share) = st.top_author();
                KeyframeRow {
                    kf_step: step,
                    path_id,
                    lines: st.lines,
                    bytes: st.bytes,
                    mean_origin_time: st.mean_origin_time(),
                    top_author,
                    top_share,
                    binary: st.binary,
                }
            })
            .collect();
        rows.sort_unstable_by_key(|r| r.path_id);
        rows
    }

    /// Total surviving lines per (cohort, author) across all files, for validation.
    pub fn census(&self) -> FxHashMap<(u16, AuthorId), i64> {
        let mut m = FxHashMap::default();
        for st in self.files.values() {
            for r in &st.runs {
                let o = &self.origins[r.origin as usize];
                *m.entry((o.month, o.author)).or_insert(0) += i64::from(r.len);
            }
        }
        m
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Naive model: one origin per line.
    fn naive_apply(old: &[u32], hunks: &[Hunk], origin_of: impl Fn(u32) -> u32) -> Vec<u32> {
        let mut out = Vec::new();
        let mut pos = 0;
        for h in hunks {
            out.extend_from_slice(&old[pos as usize..h.b0 as usize]);
            out.extend((h.a0..h.a1).map(&origin_of));
            pos = h.b1;
        }
        out.extend_from_slice(&old[pos as usize..]);
        out
    }

    fn expand(st: &FileState) -> Vec<u32> {
        st.runs
            .iter()
            .flat_map(|r| std::iter::repeat_n(r.origin, r.len as usize))
            .collect()
    }

    /// Random valid hunk list against a file of `old_len` lines.
    fn hunks_strategy(old_len: u32) -> impl Strategy<Value = Vec<Hunk>> {
        prop::collection::vec((0u32..4, 0u32..4, 0u32..5), 0..6).prop_map(move |specs| {
            let (mut b, mut a, mut hunks) = (0u32, 0u32, Vec::new());
            for (gap, del, ins) in specs {
                let b0 = (b + gap).min(old_len);
                let b1 = (b0 + del).min(old_len);
                let a0 = a + (b0 - b);
                if b1 == b0 && ins == 0 {
                    continue;
                }
                hunks.push(Hunk {
                    b0,
                    b1,
                    a0,
                    a1: a0 + ins,
                });
                a = a0 + ins;
                b = b1;
            }
            hunks
        })
    }

    proptest! {
        #[test]
        fn splice_matches_naive(old_len in 0u32..20, seed_hunks in hunks_strategy(20), steps in 1usize..4) {
            let mut t = Tracker::default();
            let o0 = t.new_origin(0, 0);
            let mut acc = DeltaAcc::default();
            let init = [Hunk { b0: 0, b1: 0, a0: 0, a1: old_len }];
            t.apply(1, &init, old_len, 0, &|_| o0, &mut acc);
            let mut model = vec![o0; old_len as usize];
            for s in 0..steps {
                let hunks: Vec<Hunk> = seed_hunks.iter().copied().filter(|h| h.b1 <= model.len() as u32).collect();
                // Keep hunks sorted/non-overlapping after filtering and recompute new coordinates.
                let mut a_shift = 0i64;
                let mut fixed = Vec::new();
                for h in hunks {
                    let a0 = (i64::from(h.b0) + a_shift) as u32;
                    let ins = h.a1 - h.a0;
                    fixed.push(Hunk { b0: h.b0, b1: h.b1, a0, a1: a0 + ins });
                    a_shift += i64::from(ins) - i64::from(h.b1 - h.b0);
                }
                let o = t.new_origin(100 * (s as i64 + 1), (s % 2) as u32);
                let oo = if s % 2 == 0 { o } else { o0 };
                let origin_of = move |line: u32| if line.is_multiple_of(3) { oo } else { o };
                let new_len = (model.len() as i64 + a_shift) as u32;
                prop_assert!(t.apply(1, &fixed, new_len, 0, &origin_of, &mut acc));
                model = naive_apply(&model, &fixed, origin_of);
                prop_assert_eq!(expand(t.get(1).unwrap()), model.clone());
            }
            // Aggregates agree with a recount.
            let st = t.get(1).unwrap();
            let sum: i64 = model.iter().map(|&o| t.origin(o).time).sum();
            prop_assert_eq!(st.sum_time, sum);
            let total: u32 = st.authors.iter().map(|(_, n)| n).sum();
            prop_assert_eq!(total, st.lines);
        }
    }

    #[test]
    fn deltas_net_to_census() {
        let mut t = Tracker::default();
        let a = t.new_origin(0, 1);
        let b = t.new_origin(40 * 86_400 * 31, 2);
        let mut acc = DeltaAcc::default();
        let mut rows = Vec::new();
        t.apply(
            7,
            &[Hunk {
                b0: 0,
                b1: 0,
                a0: 0,
                a1: 10,
            }],
            10,
            100,
            &|_| a,
            &mut acc,
        );
        acc.drain_into(0, 7, &mut rows);
        t.apply(
            7,
            &[Hunk {
                b0: 2,
                b1: 5,
                a0: 2,
                a1: 4,
            }],
            9,
            90,
            &|_| b,
            &mut acc,
        );
        acc.drain_into(1, 7, &mut rows);
        let mut net: FxHashMap<(u16, u32), i64> = FxHashMap::default();
        for r in &rows {
            *net.entry((r.cohort, r.author_id)).or_insert(0) += i64::from(r.delta);
        }
        net.retain(|_, v| *v != 0);
        assert_eq!(net, t.census());
        let (top, share) = t.get(7).unwrap().top_author();
        assert_eq!((top, share), (1, 7.0 / 9.0));
        t.delete(7, &mut acc);
        acc.drain_into(2, 7, &mut rows);
        assert_eq!(rows.iter().map(|r| i64::from(r.delta)).sum::<i64>(), 0);
    }

    #[test]
    fn inconsistent_hunks_rebuild_state() {
        let mut t = Tracker::default();
        let a = t.new_origin(0, 1);
        let mut acc = DeltaAcc::default();
        // File unknown to the tracker but the diff claims 5 old lines.
        let ok = t.apply(
            3,
            &[Hunk {
                b0: 0,
                b1: 5,
                a0: 0,
                a1: 2,
            }],
            2,
            0,
            &|_| a,
            &mut acc,
        );
        assert!(!ok);
        assert_eq!(t.get(3).unwrap().lines, 2);
    }
}
