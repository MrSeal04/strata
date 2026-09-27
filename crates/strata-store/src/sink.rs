//! `Sink` implementation: buffer engine rows, write them as Parquet part files through an
//! in-memory DuckDB (`COPY ... TO`), named by step range so interrupted runs can be trimmed.

use std::path::{Path, PathBuf};

use anyhow::Context;
use duckdb::{Connection, params};
use strata_engine::model::*;

use crate::layout::TABLES;

pub const DDL: &str = r#"
CREATE TABLE steps (step UINTEGER, sha VARCHAR, author_id UINTEGER, committer_id UINTEGER,
  author_time BIGINT, commit_time BIGINT, axis_time BIGINT, is_merge BOOLEAN, side_count UINTEGER,
  summary VARCHAR, message VARCHAR, adds UINTEGER, dels UINTEGER, adds_ws UINTEGER, dels_ws UINTEGER,
  files_changed UINTEGER, flags UTINYINT);
CREATE TABLE changes (step UINTEGER, path_id UINTEGER, kind UTINYINT, old_path_id UINTEGER,
  adds UINTEGER, dels UINTEGER, adds_ws UINTEGER, dels_ws UINTEGER, lines_after UINTEGER,
  line_delta INTEGER, bytes_after UBIGINT, mean_origin_time BIGINT, top_author UINTEGER,
  top_share FLOAT, is_binary BOOLEAN, approx BOOLEAN);
CREATE TABLE origin_deltas (step UINTEGER, path_id UINTEGER, cohort USMALLINT, author_id UINTEGER,
  delta INTEGER);
CREATE TABLE side_commits (sha VARCHAR, landing_step UINTEGER, author_id UINTEGER,
  author_time BIGINT, summary VARCHAR);
CREATE TABLE keyframes (kf_step UINTEGER, path_id UINTEGER, lines UINTEGER, bytes UBIGINT,
  mean_origin_time BIGINT, top_author UINTEGER, top_share FLOAT, is_binary BOOLEAN);
CREATE TABLE paths (path_id UINTEGER, path VARCHAR, lang VARCHAR, category UTINYINT,
  first_step UINTEGER, last_step UINTEGER);
CREATE TABLE authors (author_id UINTEGER, canonical_id UINTEGER, name VARCHAR, email VARCHAR,
  is_bot BOOLEAN);
CREATE TABLE tags (name VARCHAR, sha VARCHAR, step UINTEGER, time BIGINT, on_main BOOLEAN);
"#;

const COPY_OPTS: &str = "(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)";
/// Buffered rows (all tables) that trigger a part write.
const FLUSH_ROWS: usize = 600_000;

pub struct ParquetSink {
    dir: PathBuf,
    conn: Connection,
    steps: Vec<StepRow>,
    changes: Vec<ChangeRow>,
    deltas: Vec<OriginDeltaRow>,
    side: Vec<SideCommitRow>,
}

fn opt_id(id: u32) -> Option<u32> {
    (id != u32::MAX).then_some(id)
}

/// First step encoded in a part file name (`part-<first>-<last>.parquet` or `kf-<step>.parquet`).
fn part_first_step(name: &str) -> Option<u32> {
    let stem = name.strip_suffix(".parquet")?;
    let rest = stem.strip_prefix("part-").or_else(|| stem.strip_prefix("kf-"))?;
    rest.split('-').next()?.parse().ok()
}

impl ParquetSink {
    pub fn new(dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(DDL)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            conn,
            steps: Vec::new(),
            changes: Vec::new(),
            deltas: Vec::new(),
            side: Vec::new(),
        })
    }

    fn buffered(&self) -> usize {
        self.steps.len() + self.changes.len() + self.deltas.len() + self.side.len()
    }

    fn copy_out(&self, table: &str, file: &Path) -> anyhow::Result<()> {
        let tmp = file.with_extension("parquet.tmp");
        self.conn.execute_batch(&format!(
            "COPY {table} TO '{}' {COPY_OPTS}; DELETE FROM {table};",
            tmp.display().to_string().replace('\'', "''")
        ))?;
        std::fs::rename(&tmp, file)?;
        Ok(())
    }

    fn write_parts(&mut self) -> anyhow::Result<()> {
        let (Some(first), Some(last)) = (self.steps.first(), self.steps.last()) else {
            return Ok(());
        };
        let name = format!("part-{:010}-{:010}.parquet", first.step, last.step);
        {
            let mut app = self.conn.appender("steps")?;
            for r in self.steps.drain(..) {
                app.append_row(params![
                    r.step, r.sha, r.author_id, r.committer_id, r.author_time, r.commit_time, r.axis_time,
                    r.is_merge, r.side_count, r.summary, r.message, r.adds, r.dels, r.adds_ws, r.dels_ws,
                    r.files_changed, r.flags
                ])?;
            }
            app.flush()?;
            let mut app = self.conn.appender("changes")?;
            for r in self.changes.drain(..) {
                app.append_row(params![
                    r.step, r.path_id, r.kind, opt_id(r.old_path_id), r.adds, r.dels, r.adds_ws, r.dels_ws,
                    r.lines_after, r.line_delta, r.bytes_after, r.mean_origin_time, opt_id(r.top_author),
                    r.top_share, r.binary, r.approx
                ])?;
            }
            app.flush()?;
            let mut app = self.conn.appender("origin_deltas")?;
            for r in self.deltas.drain(..) {
                app.append_row(params![r.step, r.path_id, r.cohort, r.author_id, r.delta])?;
            }
            app.flush()?;
            let mut app = self.conn.appender("side_commits")?;
            for r in self.side.drain(..) {
                app.append_row(params![r.sha, r.landing_step, r.author_id, r.author_time, r.summary])?;
            }
            app.flush()?;
        }
        for table in ["steps", "changes", "origin_deltas", "side_commits"] {
            let dir = self.dir.join(table);
            std::fs::create_dir_all(&dir)?;
            self.copy_out(table, &dir.join(&name))?;
        }
        Ok(())
    }
}

impl Sink for ParquetSink {
    fn begin(&mut self, from_step: Step) -> anyhow::Result<()> {
        for table in TABLES {
            let dir = self.dir.join(table);
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let stale = name.ends_with(".tmp") || part_first_step(&name).is_none_or(|s| s >= from_step);
                if stale {
                    std::fs::remove_file(e.path()).with_context(|| format!("removing {name}"))?;
                }
            }
        }
        Ok(())
    }

    fn write_step(&mut self, out: StepOutput) -> anyhow::Result<()> {
        self.steps.push(out.step);
        self.changes.extend(out.changes);
        self.deltas.extend(out.deltas);
        self.side.extend(out.side_commits);
        if self.buffered() >= FLUSH_ROWS {
            self.write_parts()?;
        }
        Ok(())
    }

    fn write_keyframe(&mut self, step: Step, rows: Vec<KeyframeRow>) -> anyhow::Result<()> {
        {
            let mut app = self.conn.appender("keyframes")?;
            for r in rows {
                app.append_row(params![
                    r.kf_step, r.path_id, r.lines, r.bytes, r.mean_origin_time, opt_id(r.top_author),
                    r.top_share, r.binary
                ])?;
            }
            app.flush()?;
        }
        let dir = self.dir.join("keyframes");
        std::fs::create_dir_all(&dir)?;
        self.copy_out("keyframes", &dir.join(format!("kf-{step:010}.parquet")))
    }

    fn flush(&mut self) -> anyhow::Result<()> {
        self.write_parts()
    }

    fn finish(&mut self, dims: Dimensions) -> anyhow::Result<()> {
        self.write_parts()?;
        {
            let mut app = self.conn.appender("paths")?;
            for r in dims.paths {
                app.append_row(params![r.path_id, r.path, r.lang, r.category, r.first_step, r.last_step])?;
            }
            app.flush()?;
            let mut app = self.conn.appender("authors")?;
            for r in dims.authors {
                app.append_row(params![r.author_id, r.canonical_id, r.name, r.email, r.is_bot])?;
            }
            app.flush()?;
            let mut app = self.conn.appender("tags")?;
            for r in dims.tags {
                app.append_row(params![r.name, r.sha, r.step, r.time, r.on_main])?;
            }
            app.flush()?;
        }
        for table in ["paths", "authors", "tags"] {
            self.copy_out(table, &self.dir.join(format!("{table}.parquet")))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_names() {
        assert_eq!(part_first_step("part-0000000010-0000000020.parquet"), Some(10));
        assert_eq!(part_first_step("kf-0000000042.parquet"), Some(42));
        assert_eq!(part_first_step("x.parquet"), None);
    }
}
