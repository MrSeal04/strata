//! Query layer: one in-memory DuckDB with a schema per loaded repo (small tables materialized,
//! large ones as views over the Parquet parts). Bulk results go out as Arrow IPC streams.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, bail};
use arrow::ipc::writer::StreamWriter;
use duckdb::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::layout::Layout;

/// Load `changes` into memory below this Parquet size; above it, query the files directly.
const MATERIALIZE_BYTES: u64 = 256 << 20;

pub struct Db {
    base: Mutex<Connection>,
    pool: Mutex<Vec<Connection>>,
    /// repo id -> schema name + parquet mtime fingerprint
    loaded: Mutex<HashMap<String, (String, String)>>,
    layout: Layout,
}

/// Query-time filters shared by every endpoint.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Filters {
    /// Category codes to hide (see `strata_engine::model::category`).
    pub exclude: Vec<u8>,
    /// Only these languages (empty = all).
    pub langs: Vec<String>,
    /// Only paths under this directory ("" = whole repo).
    pub root: String,
    /// Only commits by these canonical authors (empty = all).
    pub authors: Vec<u32>,
    pub hide_bots: bool,
    /// Use whitespace-insensitive add/delete counts.
    pub ws: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    Index,
    Time,
}

/// A binning request: x in axis units, `[lo, hi)` split into `bins`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Bins {
    pub axis: Axis,
    pub lo: f64,
    pub hi: f64,
    pub bins: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Slice {
    Dir,
    Lang,
    Author,
    Cohort,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AreaMode {
    Size,
    Flow,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AreaQuery {
    pub slice: Slice,
    pub mode: AreaMode,
    pub depth: u32,
    pub top: u32,
    /// Cohort bucket: "year" | "quarter" | "month".
    pub unit: String,
}

pub fn sql_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn like_prefix(dir: &str) -> String {
    let esc = dir
        .trim_matches('/')
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    sql_str(&format!("{esc}/%"))
}

fn ids(list: &[u32]) -> String {
    list.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

impl Filters {
    /// Predicate over `paths p`.
    fn path_pred(&self) -> String {
        let mut p = vec!["TRUE".to_string()];
        if !self.exclude.is_empty() {
            p.push(format!(
                "p.category NOT IN ({})",
                self.exclude
                    .iter()
                    .map(u8::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
        if !self.langs.is_empty() {
            p.push(format!(
                "p.lang IN ({})",
                self.langs
                    .iter()
                    .map(|l| sql_str(l))
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
        if !self.root.trim_matches('/').is_empty() {
            p.push(format!(
                "p.path LIKE {} ESCAPE '\\'",
                like_prefix(&self.root)
            ));
        }
        p.join(" AND ")
    }

    /// Predicate over `steps s` (commit authorship).
    fn step_pred(&self, schema: &str) -> String {
        let mut p = vec!["TRUE".to_string()];
        if !self.authors.is_empty() {
            p.push(format!(
                "s.author_id IN (SELECT author_id FROM {schema}.authors WHERE canonical_id IN ({}))",
                ids(&self.authors)
            ));
        }
        if self.hide_bots {
            p.push(format!(
                "s.author_id NOT IN (SELECT author_id FROM {schema}.authors WHERE is_bot)"
            ));
        }
        p.join(" AND ")
    }

    fn adds(&self) -> &'static str {
        if self.ws { "adds_ws" } else { "adds" }
    }

    fn dels(&self) -> &'static str {
        if self.ws { "dels_ws" } else { "dels" }
    }
}

impl Bins {
    fn x_col(&self) -> &'static str {
        match self.axis {
            Axis::Index => "s.step::DOUBLE",
            Axis::Time => "s.axis_time::DOUBLE",
        }
    }

    /// Bin expression over x (-1 for x < lo), plus the x < hi guard.
    fn bin_expr(&self) -> (String, String) {
        let w = ((self.hi - self.lo) / f64::from(self.bins.max(1))).max(1e-9);
        let x = self.x_col();
        (
            format!(
                "CASE WHEN {x} < {lo} THEN -1 ELSE least(floor(({x} - {lo}) / {w}), {last})::INTEGER END",
                lo = self.lo,
                last = self.bins.max(1) - 1
            ),
            format!("{x} < {hi}", hi = self.hi),
        )
    }
}

pub fn ipc(conn: &Connection, sql: &str) -> anyhow::Result<Vec<u8>> {
    let mut stmt = conn
        .prepare(sql)
        .with_context(|| format!("preparing: {sql}"))?;
    let arrow = stmt.query_arrow([])?;
    let schema = arrow.get_schema();
    let mut buf = Vec::new();
    {
        let mut w = StreamWriter::try_new(&mut buf, &schema)?;
        for batch in arrow {
            w.write(&batch)?;
        }
        w.finish()?;
    }
    Ok(buf)
}

fn json_rows(conn: &Connection, sql: &str) -> anyhow::Result<Vec<Value>> {
    let mut stmt = conn
        .prepare(sql)
        .with_context(|| format!("preparing: {sql}"))?;
    let mut rows = stmt.query([])?;
    let names: Vec<String> = rows.as_ref().map(|s| s.column_names()).unwrap_or_default();
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut obj = serde_json::Map::new();
        for (i, n) in names.iter().enumerate() {
            let v: duckdb::types::Value = row.get(i)?;
            obj.insert(n.clone(), to_json(v));
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

fn to_json(v: duckdb::types::Value) -> Value {
    use duckdb::types::Value as V;
    match v {
        V::Null => Value::Null,
        V::Boolean(b) => json!(b),
        V::TinyInt(i) => json!(i),
        V::SmallInt(i) => json!(i),
        V::Int(i) => json!(i),
        V::BigInt(i) => json!(i),
        V::HugeInt(i) => json!(i as f64),
        V::UTinyInt(i) => json!(i),
        V::USmallInt(i) => json!(i),
        V::UInt(i) => json!(i),
        V::UBigInt(i) => json!(i),
        V::Float(f) => json!(f),
        V::Double(f) => json!(f),
        V::Text(s) => json!(s),
        V::List(items) | V::Array(items) => Value::Array(items.into_iter().map(to_json).collect()),
        other => json!(format!("{other:?}")),
    }
}

fn dir_fingerprint(dir: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    for table in [
        "steps",
        "changes",
        "keyframes",
        "paths.parquet",
        "authors.parquet",
    ] {
        let p = dir.join(table);
        let mut entries: Vec<String> = match std::fs::read_dir(&p) {
            Ok(rd) => rd
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
            Err(_) => std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .map(|t| vec![format!("{t:?}")])
                .unwrap_or_default(),
        };
        entries.sort();
        parts.push(entries.join(","));
    }
    parts.join("|")
}

fn glob_or_empty(dir: &Path, table: &str) -> Option<String> {
    let d = dir.join(table);
    let has = std::fs::read_dir(&d)
        .ok()?
        .flatten()
        .any(|e| e.file_name().to_string_lossy().ends_with(".parquet"));
    has.then(|| sql_str(&format!("{}/*.parquet", d.display())))
}

impl Db {
    pub fn new(layout: Layout) -> anyhow::Result<Self> {
        let base = Connection::open_in_memory()?;
        let mem = std::env::var("STRATA_DUCKDB_MEMORY").unwrap_or_else(|_| "3GB".into());
        base.execute_batch(&format!(
            "SET memory_limit = {}; SET preserve_insertion_order = false;",
            sql_str(&mem)
        ))?;
        Ok(Self {
            base: Mutex::new(base),
            pool: Mutex::new(Vec::new()),
            loaded: Mutex::new(HashMap::new()),
            layout,
        })
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    fn conn(&self) -> anyhow::Result<Connection> {
        if let Some(c) = self.pool.lock().unwrap().pop() {
            return Ok(c);
        }
        Ok(self.base.lock().unwrap().try_clone()?)
    }

    fn give_back(&self, c: Connection) {
        let mut pool = self.pool.lock().unwrap();
        if pool.len() < 16 {
            pool.push(c);
        }
    }

    /// Run `f` with a pooled connection and the repo's schema name (loading/refreshing it first).
    pub fn with<T>(
        &self,
        repo: &str,
        f: impl FnOnce(&Connection, &str) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let schema = self.ensure_loaded(repo)?;
        let conn = self.conn()?;
        let out = f(&conn, &schema);
        self.give_back(conn);
        out
    }

    /// (Re)create the repo's schema if its Parquet files changed since the last load.
    pub fn ensure_loaded(&self, repo: &str) -> anyhow::Result<String> {
        let dir = self.layout.repo_dir(repo);
        if !dir.join("paths.parquet").exists() {
            bail!("repo '{repo}' has not been extracted yet");
        }
        let fp = dir_fingerprint(&dir);
        let mut loaded = self.loaded.lock().unwrap();
        if let Some((schema, old)) = loaded.get(repo)
            && *old == fp
        {
            return Ok(schema.clone());
        }
        let schema = format!(
            "r_{}",
            repo.chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                .collect::<String>()
        );
        let conn = self.base.lock().unwrap();
        let file = |name: &str| sql_str(&dir.join(name).display().to_string());
        let steps = glob_or_empty(&dir, "steps").context("no steps extracted")?;
        let changes_bytes: u64 = std::fs::read_dir(dir.join("changes"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum();
        let changes_src = glob_or_empty(&dir, "changes");
        let mut sql = format!(
            "DROP SCHEMA IF EXISTS {schema} CASCADE; CREATE SCHEMA {schema};
             CREATE TABLE {schema}.steps AS SELECT * EXCLUDE (message) FROM read_parquet({steps}) ORDER BY step;
             CREATE VIEW {schema}.messages AS SELECT step, message FROM read_parquet({steps});
             CREATE TABLE {schema}.paths AS SELECT * FROM read_parquet({paths}) ORDER BY path_id;
             CREATE TABLE {schema}.authors AS SELECT * FROM read_parquet({authors});
             CREATE TABLE {schema}.tags AS SELECT * FROM read_parquet({tags});",
            paths = file("paths.parquet"),
            authors = file("authors.parquet"),
            tags = file("tags.parquet"),
        );
        let empty = |table: &str| -> String {
            let ddl = crate::sink::DDL
                .split(';')
                .find(|s| s.contains(&format!("CREATE TABLE {table} (")))
                .unwrap_or_default()
                .replace(
                    &format!("CREATE TABLE {table} ("),
                    &format!("CREATE TABLE {schema}.{table} ("),
                );
            format!("{ddl};")
        };
        match &changes_src {
            Some(g) if changes_bytes <= MATERIALIZE_BYTES => {
                sql += &format!(
                    "CREATE TABLE {schema}.changes AS SELECT * FROM read_parquet({g}) ORDER BY step;"
                )
            }
            Some(g) => {
                sql += &format!("CREATE VIEW {schema}.changes AS SELECT * FROM read_parquet({g});")
            }
            None => sql += &empty("changes"),
        }
        for table in ["origin_deltas", "side_commits", "keyframes"] {
            match glob_or_empty(&dir, table) {
                Some(g) if changes_bytes <= MATERIALIZE_BYTES => {
                    sql += &format!(
                        "CREATE TABLE {schema}.{table} AS SELECT * FROM read_parquet({g});"
                    )
                }
                Some(g) => {
                    sql +=
                        &format!("CREATE VIEW {schema}.{table} AS SELECT * FROM read_parquet({g});")
                }
                None => sql += &empty(table),
            }
        }
        sql += &format!(
            "CREATE TABLE {schema}.kf_steps AS SELECT DISTINCT kf_step FROM {schema}.keyframes ORDER BY kf_step;
             CREATE TABLE {schema}.canon AS SELECT a.author_id, a.canonical_id, c.name, c.email, a.is_bot
               FROM {schema}.authors a JOIN {schema}.authors c ON c.author_id = a.canonical_id;"
        );
        conn.execute_batch(&sql)
            .with_context(|| format!("loading repo {repo}"))?;
        loaded.insert(repo.to_string(), (schema.clone(), fp));
        Ok(schema)
    }

    /// Per-step axis times (seconds, monotonic) and flags, for client-side axis mapping.
    pub fn axis(&self, repo: &str) -> anyhow::Result<Vec<u8>> {
        self.with(repo, |c, s| {
            ipc(
                c,
                &format!(
                    "SELECT st.axis_time::DOUBLE AS t, st.flags, st.is_merge, k.canonical_id AS author FROM {s}.steps st LEFT JOIN {s}.canon k ON k.author_id = st.author_id ORDER BY st.step"
                ),
            )
        })
    }

    /// Path dictionary.
    pub fn paths(&self, repo: &str) -> anyhow::Result<Vec<u8>> {
        self.with(repo, |c, s| {
            ipc(c, &format!("SELECT path_id, path, lang, category, first_step, last_step FROM {s}.paths ORDER BY path_id"))
        })
    }

    /// Canonical authors with commit counts.
    pub fn authors(&self, repo: &str) -> anyhow::Result<Vec<Value>> {
        self.with(repo, |c, s| {
            json_rows(c, &format!(
                "SELECT k.canonical_id AS id, any_value(k.name) AS name, any_value(k.email) AS email,
                        bool_or(k.is_bot) AS is_bot, count(st.step)::INTEGER AS commits
                 FROM {s}.canon k LEFT JOIN {s}.steps st ON st.author_id = k.author_id
                 GROUP BY k.canonical_id ORDER BY commits DESC, id"
            ))
        })
    }

    /// Summary for the dashboard header and filter pickers.
    pub fn summary(&self, repo: &str) -> anyhow::Result<Value> {
        self.with(repo, |c, s| {
            let head = json_rows(c, &format!(
                "SELECT count(*)::INTEGER AS steps, min(axis_time)::DOUBLE AS first_time, max(axis_time)::DOUBLE AS last_time,
                        sum(adds)::DOUBLE AS adds, sum(dels)::DOUBLE AS dels, count_if(is_merge)::INTEGER AS merges
                 FROM {s}.steps"
            ))?;
            let tags = json_rows(c, &format!("SELECT name, step, time::DOUBLE AS time, on_main FROM {s}.tags ORDER BY step, name"))?;
            let langs = json_rows(c, &format!(
                "SELECT p.lang, count(*)::INTEGER AS files, sum(c.lines_after)::DOUBLE AS lines
                 FROM {s}.paths p JOIN (SELECT path_id, arg_max(lines_after, step) AS lines_after, arg_max(kind, step) AS kind
                                         FROM {s}.changes GROUP BY path_id) c USING (path_id)
                 WHERE c.kind NOT IN (2, 4) GROUP BY p.lang ORDER BY lines DESC"
            ))?;
            let cats = json_rows(c, &format!(
                "SELECT category, count(*)::INTEGER AS paths FROM {s}.paths GROUP BY category ORDER BY category"
            ))?;
            let authors = json_rows(c, &format!("SELECT count(DISTINCT canonical_id)::INTEGER AS n FROM {s}.authors"))?;
            Ok(json!({
                "head": head.into_iter().next(),
                "tags": tags,
                "langs": langs,
                "categories": cats,
                "authors": authors.first().and_then(|r| r.get("n")).cloned(),
            }))
        })
    }

    /// Binned per-commit additions/deletions.
    pub fn bars(&self, repo: &str, f: &Filters, b: &Bins) -> anyhow::Result<Vec<u8>> {
        self.with(repo, |c, s| {
            let (bin, below_hi) = b.bin_expr();
            ipc(c, &format!(
                "WITH ch AS (
                   SELECT c.step, sum(c.{a})::BIGINT AS a, sum(c.{d})::BIGINT AS d
                   FROM {s}.changes c JOIN {s}.paths p USING (path_id)
                   WHERE {pp} GROUP BY c.step),
                 j AS (
                   SELECT s.step, {bin} AS bin, coalesce(ch.a, 0) AS a, coalesce(ch.d, 0) AS d, s.is_merge
                   FROM {s}.steps s LEFT JOIN ch USING (step)
                   WHERE {sp} AND {below_hi})
                 SELECT bin, sum(a)::DOUBLE AS adds, sum(d)::DOUBLE AS dels, max(a + d)::DOUBLE AS peak,
                        arg_max(step, a + d)::INTEGER AS peak_step, count(*)::INTEGER AS commits,
                        min(step)::INTEGER AS first_step, max(step)::INTEGER AS last_step
                 FROM j WHERE bin >= 0 GROUP BY bin ORDER BY bin",
                a = f.adds(), d = f.dels(), pp = f.path_pred(), sp = f.step_pred(s),
            ))
        })
    }

    /// Stacked area series in long format: (bin, key, value) for size, (bin, key, adds, dels) for flow.
    /// Size rows are cumulative per key at the bins where the key changed; bin -1 is the baseline
    /// before `lo`. Clients forward-fill.
    pub fn area(
        &self,
        repo: &str,
        f: &Filters,
        b: &Bins,
        q: &AreaQuery,
    ) -> anyhow::Result<Vec<u8>> {
        self.with(repo, |c, s| {
            let (bin, below_hi) = b.bin_expr();
            let root = f.root.trim_matches('/');
            let rel = if root.is_empty() {
                "p.path".to_string()
            } else {
                format!("substr(p.path, {})", root.len() + 2)
            };
            let depth = q.depth.clamp(1, 8);
            let key_dir = format!(
                "CASE WHEN len(string_split({rel}, '/')) > {depth}
                      THEN array_to_string(string_split({rel}, '/')[1:{depth}], '/')
                      ELSE coalesce(nullif(array_to_string(string_split({rel}, '/')[1:-2], '/'), ''), '(files)') END"
            );
            let unit = match q.unit.as_str() {
                "month" => "strftime(make_date(1970 + (o.cohort // 12), 1 + (o.cohort % 12), 1), '%Y-%m')",
                "quarter" => "(1970 + (o.cohort // 12))::VARCHAR || '-Q' || (1 + (o.cohort % 12) // 3)::VARCHAR",
                _ => "(1970 + (o.cohort // 12))::VARCHAR",
            };
            let (source, key, v, a, d) = match q.slice {
                Slice::Dir | Slice::Lang => (
                    format!("{s}.changes c JOIN {s}.paths p USING (path_id)"),
                    if q.slice == Slice::Dir { key_dir } else { "p.lang".into() },
                    "c.line_delta".to_string(),
                    format!("c.{}", f.adds()),
                    format!("c.{}", f.dels()),
                ),
                Slice::Author | Slice::Cohort => (
                    format!("{s}.origin_deltas o JOIN {s}.paths p USING (path_id) JOIN {s}.canon k ON k.author_id = o.author_id"),
                    if q.slice == Slice::Author { "k.name".into() } else { unit.to_string() },
                    "o.delta".to_string(),
                    "greatest(o.delta, 0)".to_string(),
                    "greatest(-o.delta, 0)".to_string(),
                ),
            };
            let bot = if f.hide_bots && q.slice == Slice::Author { "AND NOT k.is_bot" } else { "" };
            let step_col = if matches!(q.slice, Slice::Dir | Slice::Lang) { "c.step" } else { "o.step" };
            let base = format!(
                "WITH k0 AS (
                   SELECT {step_col} AS step, {key} AS key, sum({v})::BIGINT AS v, sum({a})::BIGINT AS a, sum({d})::BIGINT AS d
                   FROM {source} WHERE {pp} {bot} GROUP BY ALL),
                 b AS (
                   SELECT {bin} AS bin, k0.key, sum(v)::BIGINT AS v, sum(a)::BIGINT AS a, sum(d)::BIGINT AS d
                   FROM k0 JOIN {s}.steps s USING (step) WHERE {below_hi} GROUP BY ALL)",
                pp = f.path_pred(),
            );
            let top = q.top.clamp(1, 60);
            let sql = match q.mode {
                AreaMode::Size => format!(
                    "{base},
                     cum AS (SELECT key, bin, sum(v) OVER (PARTITION BY key ORDER BY bin ROWS UNBOUNDED PRECEDING) AS c FROM b),
                     rk AS (SELECT key FROM cum GROUP BY key ORDER BY max(c) DESC, key LIMIT {top}),
                     lab AS (SELECT bin, CASE WHEN key IN (SELECT key FROM rk) THEN key ELSE '(other)' END AS key, v FROM b),
                     g AS (SELECT bin, key, sum(v)::BIGINT AS v FROM lab GROUP BY ALL)
                     SELECT bin, key, (sum(v) OVER (PARTITION BY key ORDER BY bin ROWS UNBOUNDED PRECEDING))::DOUBLE AS value
                     FROM g ORDER BY bin, key"
                ),
                AreaMode::Flow => format!(
                    "{base},
                     rk AS (SELECT key FROM b WHERE bin >= 0 GROUP BY key ORDER BY sum(a + d) DESC, key LIMIT {top}),
                     lab AS (SELECT bin, CASE WHEN key IN (SELECT key FROM rk) THEN key ELSE '(other)' END AS key, a, d FROM b WHERE bin >= 0)
                     SELECT bin, key, sum(a)::DOUBLE AS adds, sum(d)::DOUBLE AS dels FROM lab GROUP BY ALL ORDER BY bin, key"
                ),
            };
            ipc(c, &sql)
        })
    }

    /// File state after `step`: nearest keyframe plus later changes.
    pub fn state(&self, repo: &str, step: u32, f: &Filters) -> anyhow::Result<Vec<u8>> {
        self.with(repo, |c, s| ipc(c, &state_sql(s, step, f)))
    }

    /// Change events in (from, to], for forward playback.
    pub fn events(&self, repo: &str, from: i64, to: u32, f: &Filters) -> anyhow::Result<Vec<u8>> {
        self.with(repo, |c, s| {
            ipc(c, &format!(
                "SELECT c.step::INTEGER AS step, c.path_id, c.kind, c.{a}::INTEGER AS adds, c.{d}::INTEGER AS dels,
                        c.lines_after::INTEGER AS lines, c.bytes_after::DOUBLE AS bytes,
                        c.mean_origin_time::DOUBLE AS mot, k.canonical_id AS top_author, c.top_share, c.is_binary AS binary,
                        c.old_path_id
                 FROM {s}.changes c JOIN {s}.paths p USING (path_id) LEFT JOIN {s}.canon k ON k.author_id = c.top_author
                 WHERE c.step > {from} AND c.step <= {to} AND {pp}
                 ORDER BY c.step, CASE WHEN c.kind IN (2, 4) THEN 0 ELSE 1 END, c.path_id",
                a = f.adds(), d = f.dels(), pp = f.path_pred(),
            ))
        })
    }

    /// Per-path lines at two steps.
    pub fn compare(&self, repo: &str, a: u32, b: u32, f: &Filters) -> anyhow::Result<Vec<u8>> {
        self.with(repo, |c, s| {
            ipc(c, &format!(
                "WITH sa AS ({qa}), sb AS ({qb})
                 SELECT coalesce(sa.path_id, sb.path_id) AS path_id, coalesce(sa.lines, 0)::INTEGER AS lines_a,
                        coalesce(sb.lines, 0)::INTEGER AS lines_b
                 FROM sa FULL OUTER JOIN sb USING (path_id) ORDER BY path_id",
                qa = state_sql(s, a, f), qb = state_sql(s, b, f),
            ))
        })
    }

    /// Details for one step: commit, touched files, side commits, tags.
    pub fn step(&self, repo: &str, step: u32) -> anyhow::Result<Value> {
        self.with(repo, |c, s| {
            let head = json_rows(c, &format!(
                "SELECT st.step, st.sha, st.author_time::DOUBLE AS author_time, st.commit_time::DOUBLE AS commit_time,
                        st.axis_time::DOUBLE AS axis_time, st.is_merge, st.side_count, st.summary, m.message,
                        st.adds, st.dels, st.adds_ws, st.dels_ws, st.files_changed, st.flags,
                        a.name AS author, a.email AS author_email, a.canonical_id AS author_id,
                        cm.name AS committer
                 FROM {s}.steps st JOIN {s}.messages m USING (step)
                 LEFT JOIN {s}.canon a ON a.author_id = st.author_id
                 LEFT JOIN {s}.canon cm ON cm.author_id = st.committer_id
                 WHERE st.step = {step}"
            ))?;
            let files = json_rows(c, &format!(
                "SELECT p.path, c.kind, c.adds, c.dels, c.adds_ws, c.dels_ws, c.lines_after, c.is_binary AS binary, p.category, p.lang,
                        op.path AS old_path
                 FROM {s}.changes c JOIN {s}.paths p USING (path_id) LEFT JOIN {s}.paths op ON op.path_id = c.old_path_id
                 WHERE c.step = {step} AND c.kind <> 4 ORDER BY c.adds + c.dels DESC, p.path LIMIT 500"
            ))?;
            let side = json_rows(c, &format!(
                "SELECT k.name, count(*)::INTEGER AS commits FROM {s}.side_commits sc JOIN {s}.canon k USING (author_id)
                 WHERE sc.landing_step = {step} GROUP BY k.name ORDER BY commits DESC LIMIT 20"
            ))?;
            let tags = json_rows(c, &format!("SELECT name FROM {s}.tags WHERE step = {step}"))?;
            Ok(json!({ "commit": head.into_iter().next(), "files": files, "side_authors": side, "tags": tags }))
        })
    }

    /// Commits in [first, last] for a bin tooltip (largest first).
    pub fn commits(
        &self,
        repo: &str,
        first: u32,
        last: u32,
        f: &Filters,
        limit: u32,
    ) -> anyhow::Result<Vec<Value>> {
        self.with(repo, |c, s| {
            json_rows(c, &format!(
                "WITH ch AS (SELECT c.step, sum(c.{a})::BIGINT AS a, sum(c.{d})::BIGINT AS d
                             FROM {s}.changes c JOIN {s}.paths p USING (path_id)
                             WHERE c.step BETWEEN {first} AND {last} AND {pp} GROUP BY c.step)
                 SELECT s.step, s.summary, k.name AS author, s.axis_time::DOUBLE AS time, coalesce(ch.a, 0)::INTEGER AS adds,
                        coalesce(ch.d, 0)::INTEGER AS dels, s.is_merge, s.side_count
                 FROM {s}.steps s LEFT JOIN ch USING (step) LEFT JOIN {s}.canon k ON k.author_id = s.author_id
                 WHERE s.step BETWEEN {first} AND {last} AND {sp}
                 ORDER BY coalesce(ch.a, 0) + coalesce(ch.d, 0) DESC, s.step LIMIT {limit}",
                a = f.adds(), d = f.dels(), pp = f.path_pred(), sp = f.step_pred(s),
            ))
        })
    }

    /// Search commits by message, author or path. Returns matching steps and path ids.
    pub fn search(&self, repo: &str, q: &str, kind: &str, limit: u32) -> anyhow::Result<Value> {
        let pat = sql_str(&format!(
            "%{}%",
            q.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        ));
        self.with(repo, |c, s| {
            let (steps_sql, paths_sql) = match kind {
                "author" => (
                    format!(
                        "SELECT DISTINCT step FROM (
                           SELECT st.step FROM {s}.steps st JOIN {s}.canon k ON k.author_id = st.author_id
                           WHERE k.name ILIKE {pat} ESCAPE '\\' OR k.email ILIKE {pat} ESCAPE '\\'
                           UNION ALL
                           SELECT sc.landing_step FROM {s}.side_commits sc JOIN {s}.canon k ON k.author_id = sc.author_id
                           WHERE k.name ILIKE {pat} ESCAPE '\\' OR k.email ILIKE {pat} ESCAPE '\\')
                         ORDER BY step LIMIT {limit}"
                    ),
                    None,
                ),
                "path" => (
                    format!(
                        "SELECT DISTINCT c.step FROM {s}.changes c JOIN {s}.paths p USING (path_id)
                         WHERE p.path ILIKE {pat} ESCAPE '\\' ORDER BY c.step LIMIT {limit}"
                    ),
                    Some(format!("SELECT path_id FROM {s}.paths WHERE path ILIKE {pat} ESCAPE '\\' LIMIT {limit}")),
                ),
                _ => (
                    format!(
                        "SELECT DISTINCT step FROM (
                           SELECT step FROM {s}.messages WHERE message ILIKE {pat} ESCAPE '\\'
                           UNION ALL SELECT landing_step FROM {s}.side_commits WHERE summary ILIKE {pat} ESCAPE '\\'
                           UNION ALL SELECT step FROM {s}.steps WHERE sha LIKE {pre})
                         ORDER BY step LIMIT {limit}",
                        pre = sql_str(&format!("{}%", q.to_lowercase().replace('\'', "")))
                    ),
                    None,
                ),
            };
            let steps: Vec<Value> = json_rows(c, &steps_sql)?.into_iter().filter_map(|r| r.get("step").cloned()).collect();
            let paths: Vec<Value> = match paths_sql {
                Some(q) => json_rows(c, &q)?.into_iter().filter_map(|r| r.get("path_id").cloned()).collect(),
                None => vec![],
            };
            Ok(json!({ "steps": steps, "paths": paths }))
        })
    }

    /// Top directories at the tip (for the root picker).
    pub fn dirs(&self, repo: &str, parent: &str, f: &Filters) -> anyhow::Result<Vec<Value>> {
        let mut f = f.clone();
        f.root = parent.to_string();
        self.with(repo, |c, s| {
            let last: u32 = c.query_row(&format!("SELECT coalesce(max(step), 0)::UINTEGER FROM {s}.steps"), [], |r| r.get(0))?;
            let root = parent.trim_matches('/');
            let rel = if root.is_empty() { "p.path".to_string() } else { format!("substr(p.path, {})", root.len() + 2) };
            json_rows(c, &format!(
                "WITH st AS ({state})
                 SELECT string_split({rel}, '/')[1] AS name, len(string_split({rel}, '/')) > 1 AS is_dir,
                        sum(st.lines)::DOUBLE AS lines, count(*)::INTEGER AS files
                 FROM st JOIN {s}.paths p USING (path_id) GROUP BY ALL ORDER BY lines DESC LIMIT 200",
                state = state_sql(s, last, &f),
            ))
        })
    }
}

fn state_sql(s: &str, step: u32, f: &Filters) -> String {
    format!(
        "WITH kf AS (SELECT max(kf_step) AS k FROM {s}.kf_steps WHERE kf_step <= {step}),
         u AS (
           SELECT path_id, lines, bytes, mean_origin_time, top_author, top_share, is_binary, 0::UTINYINT AS kind,
                  kf_step::BIGINT * 8 + 7 AS ord, NULL::INTEGER AS touched
           FROM {s}.keyframes WHERE kf_step = (SELECT k FROM kf)
           UNION ALL
           SELECT path_id, lines_after, bytes_after, mean_origin_time, top_author, top_share, is_binary, kind,
                  step::BIGINT * 8 + CASE WHEN kind IN (2, 4) THEN 1 ELSE 2 END AS ord, step::INTEGER AS touched
           FROM {s}.changes WHERE step > coalesce((SELECT k FROM kf), -1) AND step <= {step}),
         last AS (
           SELECT path_id, arg_max(lines, ord) AS lines, arg_max(bytes, ord) AS bytes,
                  arg_max(mean_origin_time, ord) AS mot, arg_max(top_author, ord) AS top_author,
                  arg_max(top_share, ord) AS top_share, arg_max(is_binary, ord) AS is_binary, arg_max(kind, ord) AS kind,
                  max(touched) AS touched
           FROM u GROUP BY path_id)
         SELECT l.path_id, l.lines::INTEGER AS lines, l.bytes::DOUBLE AS bytes, l.mot::DOUBLE AS mot,
                k.canonical_id AS top_author, l.top_share, l.is_binary AS binary, l.touched
         FROM last l JOIN {s}.paths p USING (path_id) LEFT JOIN {s}.canon k ON k.author_id = l.top_author
         WHERE l.kind NOT IN (2, 4) AND {pp}",
        pp = f.path_pred(),
    )
}
