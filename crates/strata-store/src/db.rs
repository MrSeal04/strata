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
    /// SQL -> Arrow IPC result. Cleared whenever a repo's tables are (re)loaded.
    cache: Mutex<QueryCache>,
    /// Serializes lazy aggregate creation.
    agg_lock: Mutex<()>,
}

#[derive(Default)]
struct QueryCache {
    entries: HashMap<String, (std::sync::Arc<Vec<u8>>, u64)>,
    bytes: usize,
    tick: u64,
}

const CACHE_BYTES: usize = 256 << 20;

impl QueryCache {
    fn get(&mut self, sql: &str) -> Option<std::sync::Arc<Vec<u8>>> {
        self.tick += 1;
        let tick = self.tick;
        self.entries.get_mut(sql).map(|(v, t)| {
            *t = tick;
            v.clone()
        })
    }

    fn put(&mut self, sql: &str, v: std::sync::Arc<Vec<u8>>) {
        if v.len() > CACHE_BYTES / 4 {
            return;
        }
        self.tick += 1;
        self.bytes += v.len();
        if let Some((old, _)) = self.entries.insert(sql.to_string(), (v, self.tick)) {
            self.bytes -= old.len();
        }
        while self.bytes > CACHE_BYTES {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (_, t))| *t)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some((v, _)) = self.entries.remove(&oldest) {
                self.bytes -= v.len();
            }
        }
    }
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
            cache: Mutex::new(QueryCache::default()),
            agg_lock: Mutex::new(()),
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

    /// Drop cached query results (benchmarks measure cold queries).
    pub fn clear_cache(&self) {
        *self.cache.lock().unwrap() = QueryCache::default();
    }

    /// `ipc` with a result cache (every query is deterministic for a given loaded repo).
    fn ipc_cached(&self, c: &Connection, sql: &str) -> anyhow::Result<Vec<u8>> {
        if let Some(v) = self.cache.lock().unwrap().get(sql) {
            return Ok(v.as_ref().clone());
        }
        let v = ipc(c, sql)?;
        self.cache
            .lock()
            .unwrap()
            .put(sql, std::sync::Arc::new(v.clone()));
        Ok(v)
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
        *self.cache.lock().unwrap() = QueryCache::default();
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
            self.ipc_cached(c, &format!("SELECT path_id, path, lang, category, first_step, last_step FROM {s}.paths ORDER BY path_id"))
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
            // Languages at the tip: the file state at the last step (keyframe + later changes).
            let last: u32 = c.query_row(&format!("SELECT coalesce(max(step), 0)::UINTEGER FROM {s}.steps"), [], |r| r.get(0))?;
            let langs = json_rows(c, &format!(
                "SELECT p.lang, count(*)::INTEGER AS files, sum(st.lines)::DOUBLE AS lines
                 FROM ({state}) st JOIN {s}.paths p USING (path_id) GROUP BY p.lang ORDER BY lines DESC",
                state = state_sql(s, last, &Filters::default()),
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
            self.ipc_cached(c, &format!(
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
            let pp = f.path_pred();
            let filtered = pp != "TRUE";
            let top = q.top.clamp(1, 60);
            // k0: per (step, key) sums. Keys are computed once per path (dir/lang) or are integers
            // (author/cohort) so the per-change work is only joins and sums.
            // Common case (no folder filter; language filter only for the language slice): read a
            // per-repo aggregate by (step, key, category), built on first use, instead of every
            // change or survival row.
            let simple = f.root.trim_matches('/').is_empty() && (f.langs.is_empty() || q.slice == Slice::Lang);
            let agg = if simple { Some(self.ensure_area_agg(c, s, q)?) } else { None };
            let (k0, label) = match (q.slice, agg) {
                (_, Some(table)) => {
                    let mut pred = vec!["TRUE".to_string()];
                    if !f.exclude.is_empty() {
                        pred.push(format!("category NOT IN ({})", f.exclude.iter().map(u8::to_string).collect::<Vec<_>>().join(",")));
                    }
                    if q.slice == Slice::Lang && !f.langs.is_empty() {
                        pred.push(format!("key IN ({})", f.langs.iter().map(|l| sql_str(l)).collect::<Vec<_>>().join(",")));
                    }
                    if q.slice == Slice::Author && f.hide_bots {
                        pred.push("NOT is_bot".into());
                    }
                    let (a, d) = if f.ws && matches!(q.slice, Slice::Dir | Slice::Lang) { ("aw", "dw") } else { ("a", "d") };
                    let key = match (q.slice, q.unit.as_str()) {
                        (Slice::Cohort, "month") => "key",
                        (Slice::Cohort, "quarter") => "key // 3",
                        (Slice::Cohort, _) => "key // 12",
                        _ => "key",
                    };
                    let label = match (q.slice, q.unit.as_str()) {
                        (Slice::Author, _) => format!("coalesce((SELECT any_value(name) FROM {s}.canon WHERE canonical_id = key), 'author ' || key::VARCHAR)"),
                        (Slice::Cohort, "month") => "strftime(make_date(1970 + (key // 12)::INTEGER, 1 + (key % 12)::INTEGER, 1), '%Y-%m')".to_string(),
                        (Slice::Cohort, "quarter") => "(1970 + key // 4)::VARCHAR || '-Q' || (1 + key % 4)::VARCHAR".to_string(),
                        (Slice::Cohort, _) => "(1970 + key)::VARCHAR".to_string(),
                        _ => "key".to_string(),
                    };
                    (
                        format!(
                            "k0 AS (SELECT step, {key} AS key, sum(v)::BIGINT AS v, sum({a})::BIGINT AS a, sum({d})::BIGINT AS d
                                    FROM {s}.{table} WHERE {pred} GROUP BY ALL)",
                            pred = pred.join(" AND ")
                        ),
                        label,
                    )
                }
                (Slice::Dir | Slice::Lang, None) => {
                    let root = f.root.trim_matches('/');
                    let rel = if root.is_empty() { "p.path".to_string() } else { format!("substr(p.path, {})", root.len() + 2) };
                    let depth = q.depth.clamp(1, 8);
                    let key = if q.slice == Slice::Lang {
                        "p.lang".to_string()
                    } else {
                        format!(
                            "CASE WHEN len(string_split({rel}, '/')) > {depth}
                                  THEN array_to_string(string_split({rel}, '/')[1:{depth}], '/')
                                  ELSE coalesce(nullif(array_to_string(string_split({rel}, '/')[1:-2], '/'), ''), '(files)') END"
                        )
                    };
                    (
                        format!(
                            "pk AS (SELECT path_id, {key} AS key FROM {s}.paths p WHERE {pp}),
                             k0 AS (SELECT c.step, pk.key, sum(c.line_delta)::BIGINT AS v, sum(c.{a})::BIGINT AS a,
                                           sum(c.{d})::BIGINT AS d
                                    FROM {s}.changes c JOIN pk USING (path_id) GROUP BY ALL)",
                            a = f.adds(),
                            d = f.dels(),
                        ),
                        "key".to_string(),
                    )
                }
                (Slice::Author | Slice::Cohort, None) => {
                    let paths = if filtered { format!("AND o.path_id IN (SELECT path_id FROM {s}.paths p WHERE {pp})") } else { String::new() };
                    let (key, join, bots) = if q.slice == Slice::Author {
                        let bots = if f.hide_bots { "AND NOT k.is_bot" } else { "" };
                        ("k.canonical_id::BIGINT", format!("JOIN {s}.canon k ON k.author_id = o.author_id"), bots)
                    } else {
                        let div = match q.unit.as_str() {
                            "month" => 1,
                            "quarter" => 3,
                            _ => 12,
                        };
                        (if div == 1 { "o.cohort::BIGINT" } else { if div == 3 { "(o.cohort // 3)::BIGINT" } else { "(o.cohort // 12)::BIGINT" } }, String::new(), "")
                    };
                    let label = match (q.slice, q.unit.as_str()) {
                        (Slice::Author, _) => format!("coalesce((SELECT any_value(name) FROM {s}.canon WHERE canonical_id = key), 'author ' || key::VARCHAR)"),
                        (_, "month") => "strftime(make_date(1970 + (key // 12)::INTEGER, 1 + (key % 12)::INTEGER, 1), '%Y-%m')".to_string(),
                        (_, "quarter") => "(1970 + key // 4)::VARCHAR || '-Q' || (1 + key % 4)::VARCHAR".to_string(),
                        _ => "(1970 + key)::VARCHAR".to_string(),
                    };
                    (
                        format!(
                            "k0 AS (SELECT o.step, {key} AS key, sum(o.delta)::BIGINT AS v,
                                           sum(greatest(o.delta, 0))::BIGINT AS a, sum(greatest(-o.delta, 0))::BIGINT AS d
                                    FROM {s}.origin_deltas o {join} WHERE TRUE {paths} {bots} GROUP BY ALL)"
                        ),
                        label,
                    )
                }
            };
            let base = format!(
                "WITH {k0},
                 b AS (SELECT {bin} AS bin, k0.key, sum(v)::BIGINT AS v, sum(a)::BIGINT AS a, sum(d)::BIGINT AS d
                       FROM k0 JOIN {s}.steps s USING (step) WHERE {below_hi} GROUP BY ALL)"
            );
            // Labels (author names, cohort dates) are resolved for the top keys only, then joined.
            let sql = match q.mode {
                AreaMode::Size => {
                    // Rank by peak size; for authors (tens of thousands of keys on big repos) by
                    // surviving lines at the end of the range, which needs no per-key window.
                    let rank = if q.slice == Slice::Author {
                        format!("SELECT key FROM b GROUP BY key ORDER BY sum(v) DESC, key LIMIT {top}")
                    } else {
                        format!(
                            "SELECT key FROM (SELECT key, sum(v) OVER (PARTITION BY key ORDER BY bin ROWS UNBOUNDED PRECEDING) AS c FROM b)
                             GROUP BY key ORDER BY max(c) DESC, key LIMIT {top}"
                        )
                    };
                    format!(
                        "{base},
                         rk AS (SELECT key, {label} AS label FROM ({rank})),
                         g AS (SELECT b.bin, coalesce(rk.label, '(other)') AS key, sum(b.v)::BIGINT AS v
                               FROM b LEFT JOIN rk USING (key) GROUP BY ALL)
                         SELECT bin, key, (sum(v) OVER (PARTITION BY key ORDER BY bin ROWS UNBOUNDED PRECEDING))::DOUBLE AS value
                         FROM g ORDER BY bin, key"
                    )
                }
                AreaMode::Flow => format!(
                    "{base},
                     rk AS (SELECT key, {label} AS label FROM (SELECT key FROM b WHERE bin >= 0 GROUP BY key ORDER BY sum(a + d) DESC, key LIMIT {top}))
                     SELECT b.bin, coalesce(rk.label, '(other)') AS key, sum(b.a)::DOUBLE AS adds, sum(b.d)::DOUBLE AS dels
                     FROM b LEFT JOIN rk USING (key) WHERE b.bin >= 0 GROUP BY ALL ORDER BY bin, key"
                ),
            };
            self.ipc_cached(c, &sql)
        })
    }

    /// Build (once per loaded repo) the aggregate an area query reads; returns its table name.
    fn ensure_area_agg(&self, c: &Connection, s: &str, q: &AreaQuery) -> anyhow::Result<String> {
        let (table, sql) = match q.slice {
            Slice::Dir | Slice::Lang => {
                let depth = q.depth.clamp(1, 8);
                let (table, key) = if q.slice == Slice::Lang {
                    ("agg_lang".to_string(), "p.lang".to_string())
                } else {
                    (
                        format!("agg_dir{depth}"),
                        format!(
                            "CASE WHEN len(string_split(p.path, '/')) > {depth}
                                  THEN array_to_string(string_split(p.path, '/')[1:{depth}], '/')
                                  ELSE coalesce(nullif(array_to_string(string_split(p.path, '/')[1:-2], '/'), ''), '(files)') END"
                        ),
                    )
                };
                let sql = format!(
                    "CREATE TABLE IF NOT EXISTS {s}.{table} AS
                     WITH pk AS (SELECT path_id, {key} AS key, category FROM {s}.paths p)
                     SELECT c.step, pk.key, pk.category, sum(c.line_delta)::BIGINT AS v, sum(c.adds)::BIGINT AS a,
                            sum(c.dels)::BIGINT AS d, sum(c.adds_ws)::BIGINT AS aw, sum(c.dels_ws)::BIGINT AS dw
                     FROM {s}.changes c JOIN pk USING (path_id) GROUP BY ALL"
                );
                (table, sql)
            }
            Slice::Author => (
                "agg_author".to_string(),
                format!(
                    "CREATE TABLE IF NOT EXISTS {s}.agg_author AS
                     SELECT o.step, k.canonical_id::BIGINT AS key, p.category, k.is_bot, sum(o.delta)::BIGINT AS v,
                            sum(greatest(o.delta, 0))::BIGINT AS a, sum(greatest(-o.delta, 0))::BIGINT AS d
                     FROM {s}.origin_deltas o JOIN {s}.paths p USING (path_id) JOIN {s}.canon k ON k.author_id = o.author_id
                     GROUP BY ALL"
                ),
            ),
            Slice::Cohort => (
                "agg_cohort".to_string(),
                format!(
                    "CREATE TABLE IF NOT EXISTS {s}.agg_cohort AS
                     SELECT o.step, o.cohort::BIGINT AS key, p.category, sum(o.delta)::BIGINT AS v,
                            sum(greatest(o.delta, 0))::BIGINT AS a, sum(greatest(-o.delta, 0))::BIGINT AS d
                     FROM {s}.origin_deltas o JOIN {s}.paths p USING (path_id) GROUP BY ALL"
                ),
            ),
        };
        let _guard = self.agg_lock.lock().unwrap();
        c.execute_batch(&sql)
            .with_context(|| format!("building {table}"))?;
        Ok(table)
    }

    /// File state after `step`: nearest keyframe plus later changes, with each file's last edit.
    pub fn state(&self, repo: &str, step: u32, f: &Filters) -> anyhow::Result<Vec<u8>> {
        self.with(repo, |c, s| {
            self.ensure_rename_edits(c, s)?;
            self.ipc_cached(c, &state_sql_edited(s, step, f))
        })
    }

    /// Build (once per loaded repo) `rename_edits`: for each pure rename (a path moved without
    /// content changes), the step that last edited its content, carried over from the path it
    /// came from (through chains of moves). Every other change row is an edit at its own step.
    fn ensure_rename_edits(&self, c: &Connection, s: &str) -> anyhow::Result<()> {
        use arrow::array::{Array, BooleanArray, UInt8Array, UInt32Array};
        let _guard = self.agg_lock.lock().unwrap();
        let have: i64 = c.query_row(
            "SELECT count(*) FROM duckdb_tables() WHERE schema_name = ? AND table_name = 'rename_edits'",
            [s],
            |r| r.get(0),
        )?;
        if have > 0 {
            return Ok(());
        }
        // Within a step, removals (deleted, moved away) come first, so a move's source is
        // stashed before its destination row is read.
        let mut stmt = c.prepare(&format!(
            "SELECT step::UINTEGER, path_id::UINTEGER, kind::UTINYINT, coalesce(old_path_id, 0)::UINTEGER,
                    coalesce(adds + dels > 0, false)
             FROM {s}.changes ORDER BY step, CASE WHEN kind IN (2, 4) THEN 0 ELSE 1 END, path_id"
        ))?;
        let mut last: HashMap<u32, u32> = HashMap::new();
        let mut moved: HashMap<u32, u32> = HashMap::new();
        let mut cur = u32::MAX;
        let mut out: Vec<(u32, u32, u32)> = Vec::new();
        for batch in stmt.query_arrow([])? {
            let col = |i: usize| batch.column(i).clone();
            let (steps, paths, kinds, olds, content) = (col(0), col(1), col(2), col(3), col(4));
            let steps = steps
                .as_any()
                .downcast_ref::<UInt32Array>()
                .context("step")?;
            let paths = paths
                .as_any()
                .downcast_ref::<UInt32Array>()
                .context("path_id")?;
            let kinds = kinds
                .as_any()
                .downcast_ref::<UInt8Array>()
                .context("kind")?;
            let olds = olds
                .as_any()
                .downcast_ref::<UInt32Array>()
                .context("old_path_id")?;
            let content = content
                .as_any()
                .downcast_ref::<BooleanArray>()
                .context("content")?;
            for i in 0..batch.num_rows() {
                let (step, path) = (steps.value(i), paths.value(i));
                if step != cur {
                    moved.clear();
                    cur = step;
                }
                match kinds.value(i) {
                    2 => {
                        last.remove(&path);
                    }
                    4 => {
                        if let Some(e) = last.remove(&path) {
                            moved.insert(path, e);
                        }
                    }
                    3 if !content.value(i) => {
                        let e = moved.get(&olds.value(i)).copied().unwrap_or(step);
                        last.insert(path, e);
                        out.push((step, path, e));
                    }
                    _ => {
                        last.insert(path, step);
                    }
                }
            }
        }
        // Fill a side table, then rename it: no reader ever sees it half-built.
        c.execute_batch(&format!(
            "DROP TABLE IF EXISTS {s}.rename_edits_tmp;
             CREATE TABLE {s}.rename_edits_tmp (step UINTEGER, path_id UINTEGER, edited UINTEGER);"
        ))?;
        {
            let mut app = c.appender_to_db("rename_edits_tmp", s)?;
            for (step, path, edited) in out {
                app.append_row(duckdb::params![step, path, edited])?;
            }
            app.flush()?;
        }
        c.execute_batch(&format!(
            "ALTER TABLE {s}.rename_edits_tmp RENAME TO rename_edits;"
        ))?;
        Ok(())
    }

    /// Change events in (from, to], for forward playback. `edited` follows the /state rule.
    pub fn events(&self, repo: &str, from: i64, to: u32, f: &Filters) -> anyhow::Result<Vec<u8>> {
        self.with(repo, |c, s| {
            self.ensure_rename_edits(c, s)?;
            self.ipc_cached(c, &format!(
                "SELECT c.step::INTEGER AS step, c.path_id, c.kind, c.{a}::INTEGER AS adds, c.{d}::INTEGER AS dels,
                        c.lines_after::INTEGER AS lines, c.bytes_after::DOUBLE AS bytes,
                        c.mean_origin_time::DOUBLE AS mot, k.canonical_id AS top_author, c.top_share, c.is_binary AS binary,
                        c.old_path_id,
                        (CASE WHEN c.kind = 3 AND c.adds + c.dels = 0 THEN coalesce(r.edited, c.step) ELSE c.step END)::INTEGER AS edited
                 FROM {s}.changes c JOIN {s}.paths p USING (path_id) LEFT JOIN {s}.canon k ON k.author_id = c.top_author
                 LEFT JOIN {s}.rename_edits r ON r.step = c.step AND r.path_id = c.path_id
                 WHERE c.step > {from} AND c.step <= {to} AND {pp}
                 ORDER BY c.step, CASE WHEN c.kind IN (2, 4) THEN 0 ELSE 1 END, c.path_id",
                a = f.adds(), d = f.dels(), pp = f.path_pred(),
            ))
        })
    }

    /// Per-path lines at two steps.
    pub fn compare(&self, repo: &str, a: u32, b: u32, f: &Filters) -> anyhow::Result<Vec<u8>> {
        self.with(repo, |c, s| {
            self.ipc_cached(c, &format!(
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

/// `state_sql` plus `edited`: the step that last changed each file's content. Every change row
/// is an edit at its own step except a pure rename, which carries its source's (`rename_edits`).
/// One aggregate over all changes up to `step`: about 20 ms at Linux's HEAD (1.7M rows).
/// (`rename_edits` has one row per (step, path_id), and the CASE picks it only for a rename.
/// A left-only term in the ON clause, like `AND c.kind = 3`, made this join 250× slower.)
fn state_sql_edited(s: &str, step: u32, f: &Filters) -> String {
    format!(
        "WITH st AS ({state}),
         ed AS (SELECT c.path_id,
                       arg_max(CASE WHEN c.kind = 3 AND c.adds + c.dels = 0 THEN coalesce(r.edited, c.step) ELSE c.step END,
                               c.step::BIGINT * 8 + CASE WHEN c.kind IN (2, 4) THEN 1 ELSE 2 END)::INTEGER AS edited
                FROM {s}.changes c LEFT JOIN {s}.rename_edits r ON r.step = c.step AND r.path_id = c.path_id
                WHERE c.step <= {step} GROUP BY c.path_id)
         SELECT st.*, ed.edited FROM st LEFT JOIN ed USING (path_id)",
        state = state_sql(s, step, f),
    )
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
