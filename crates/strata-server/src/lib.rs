//! strata HTTP server: JSON/Arrow API over the store, extraction jobs with SSE progress, and the
//! embedded web UI.

pub mod jobs;
pub mod render;

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures_util::Stream;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{Value, json};
use strata_engine::ExtractOptions;
use strata_store::pipeline::{Busy, Credentials, remove_repo};
use strata_store::{
    AreaMode, AreaQuery, Axis, Bins, CompositionQuery, Db, Filters, Layout, Slice, Source,
};
use tokio::sync::broadcast::error::RecvError;

use crate::jobs::{JobState, Jobs};

#[derive(RustEmbed)]
#[folder = "../../web/dist"]
#[allow_missing = true]
struct Assets;

pub struct AppState {
    pub db: Db,
    pub layout: Layout,
    pub jobs: Arc<Jobs>,
    pub extract_opts: ExtractOptions,
    pub renders: render::Renders,
    /// When the last API request arrived, for `exit_when_idle`.
    pub last_seen: Mutex<Instant>,
    /// Stops the server gracefully, as Ctrl-C does.
    pub shutdown: tokio::sync::Notify,
}

type Shared = Arc<AppState>;

pub struct ApiError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        ApiError(e.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let msg = format!("{:#}", self.0);
        let status = if self.0.chain().any(|c| c.is::<Busy>()) {
            StatusCode::CONFLICT
        } else if msg.contains("not been extracted") || msg.contains("not found") {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        tracing::warn!("{status}: {msg}");
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

fn arrow(bytes: Vec<u8>) -> Response {
    (
        [(header::CONTENT_TYPE, "application/vnd.apache.arrow.stream")],
        bytes,
    )
        .into_response()
}

/// Run a blocking DB call off the async runtime.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> ApiResult<T> {
    Ok(tokio::task::spawn_blocking(f).await??)
}

fn list_u32(s: Option<&String>) -> Vec<u32> {
    s.map(|v| v.split(',').filter_map(|x| x.trim().parse().ok()).collect())
        .unwrap_or_default()
}

/// Filters from query params: exclude=4,5 langs=Rust,Go root=src authors=1,2 bots=0 ws=1
fn filters(q: &HashMap<String, String>) -> Filters {
    Filters {
        exclude: q
            .get("exclude")
            .map(|v| v.split(',').filter_map(|x| x.trim().parse().ok()).collect())
            .unwrap_or_else(|| vec![4, 5, 6, 7]),
        langs: q
            .get("langs")
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default(),
        root: q.get("root").cloned().unwrap_or_default(),
        authors: list_u32(q.get("authors")),
        hide_bots: q.get("bots").is_some_and(|v| v == "0"),
        ws: q.get("ws").is_some_and(|v| v == "1"),
    }
}

fn bins(q: &HashMap<String, String>) -> ApiResult<Bins> {
    let num = |k: &str| -> ApiResult<f64> {
        q.get(k)
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| ApiError(anyhow::anyhow!("missing or bad '{k}'")))
    };
    Ok(Bins {
        axis: if q.get("axis").is_some_and(|a| a == "time") {
            Axis::Time
        } else {
            Axis::Index
        },
        lo: num("lo")?,
        hi: num("hi")?,
        bins: num("bins")?.clamp(1.0, 20_000.0) as u32,
    })
}

/// Open dashboards call this every minute; the launcher checks for a running server with it.
async fn ping() -> Json<Value> {
    Json(json!({ "app": "strata", "version": env!("CARGO_PKG_VERSION") }))
}

/// Note every API request: open pages keep `exit_when_idle` from stopping the server.
async fn touch(State(st): State<Shared>, req: Request, next: Next) -> Response {
    *st.last_seen.lock().unwrap() = Instant::now();
    next.run(req).await
}

/// Stop the server once no page has called the API for `idle` and no extraction is running.
/// Hidden tabs may run their once-a-minute ping only that often, so `idle` should be minutes.
pub fn exit_when_idle(state: Shared, idle: Duration) {
    tokio::spawn(async move {
        let tick = (idle / 4).clamp(Duration::from_millis(50), Duration::from_secs(15));
        loop {
            tokio::time::sleep(tick).await;
            let quiet = state.last_seen.lock().unwrap().elapsed();
            if quiet >= idle && !state.jobs.any_running() {
                tracing::info!("no page open for {}s: stopping", quiet.as_secs());
                state.shutdown.notify_one();
                return;
            }
        }
    });
}

async fn list_repos(State(st): State<Shared>) -> ApiResult<Json<Value>> {
    let layout = st.layout.clone();
    let repos = blocking(move || {
        Ok(layout
            .list()
            .into_iter()
            .map(|m| {
                // What deleting it frees: the cached tables, plus the clone of a remote.
                let mut bytes = dir_bytes(&layout.repo_dir(&m.id));
                if let Source::Url { url } = &m.source {
                    bytes += dir_bytes(&layout.clone_dir(url));
                }
                let mut v = serde_json::to_value(&m).unwrap_or_default();
                v["disk_bytes"] = json!(bytes);
                v
            })
            .collect::<Vec<_>>())
    })
    .await?;
    Ok(Json(json!({ "repos": repos, "jobs": st.jobs.all() })))
}

/// Total size of the files under `dir` (0 if it is missing).
fn dir_bytes(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_bytes(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map_or(0, |m| m.len()),
            _ => 0,
        })
        .sum()
}

/// Fetch (for a remote) and extract a cached repo again, incrementally, on the branch it was
/// extracted from: following a work tree's HEAD onto another branch would discard the cache.
async fn update_repo(State(st): State<Shared>, Path(repo): Path<String>) -> ApiResult<Json<Value>> {
    let meta = st
        .layout
        .list()
        .into_iter()
        .find(|m| m.id == repo)
        .ok_or_else(|| anyhow::anyhow!("repo '{repo}' not found"))?;
    let mut opts = st.extract_opts.clone();
    if meta.branch != "HEAD" {
        opts.branch = Some(meta.branch);
    }
    let job = st
        .jobs
        .start(st.layout.clone(), meta.source, opts, true, None, |_| {});
    let status = job.status.lock().unwrap().clone();
    Ok(Json(serde_json::to_value(status)?))
}

/// Delete a cached repo's data (and a remote's clone); a local repository is never touched.
async fn delete_repo(State(st): State<Shared>, Path(repo): Path<String>) -> ApiResult<Json<Value>> {
    let meta = st
        .layout
        .list()
        .into_iter()
        .find(|m| m.id == repo)
        .ok_or_else(|| anyhow::anyhow!("repo '{repo}' not found"))?;
    if st.jobs.running_for(&repo).is_some() {
        return Err(Busy { name: meta.name }.into());
    }
    let s = st.clone();
    let removed = blocking(move || {
        s.db.unload(&repo)?;
        remove_repo(&s.layout, &repo)
    })
    .await?;
    if let Source::Url { url } = &meta.source {
        st.jobs.forget_login(url);
    }
    for d in &removed {
        tracing::info!("removed {}", d.display());
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct AddRepo {
    source: String,
    #[serde(default)]
    full: bool,
    /// A login for a private HTTP(S) remote, kept in memory only.
    username: Option<String>,
    password: Option<String>,
}

async fn add_repo(State(st): State<Shared>, Json(body): Json<AddRepo>) -> ApiResult<Json<Value>> {
    let source = Source::parse(body.source.trim())?;
    let mut opts = st.extract_opts.clone();
    opts.full = body.full;
    let login = match (body.username.as_deref(), body.password.as_deref()) {
        (None, None) => None,
        (u, p) => Some(Credentials::new(
            u.unwrap_or_default().trim(),
            p.unwrap_or_default(),
        )?),
    };
    let job = st
        .jobs
        .start(st.layout.clone(), source, opts, true, login, |_| {});
    let status = job.status.lock().unwrap().clone();
    Ok(Json(serde_json::to_value(status)?))
}

async fn job_status(State(st): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let job = st
        .jobs
        .get(&id)
        .ok_or_else(|| anyhow::anyhow!("job {id} not found"))?;
    let status = job.status.lock().unwrap().clone();
    Ok(Json(serde_json::to_value(status)?))
}

async fn cancel_job(State(st): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let job = st
        .jobs
        .get(&id)
        .ok_or_else(|| anyhow::anyhow!("job {id} not found"))?;
    job.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(Json(json!({ "ok": true })))
}

async fn job_events(
    State(st): State<Shared>,
    Path(id): Path<String>,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let job = st
        .jobs
        .get(&id)
        .ok_or_else(|| anyhow::anyhow!("job {id} not found"))?;
    let rx = job.tx.subscribe();
    let first = job.status.lock().unwrap().clone();
    // The current status, then each update, ending right after the job's final one: the stream
    // ends with the job, so it can't hold a shutting-down server open.
    let stream = futures_util::stream::unfold(
        (Some(first), rx, false),
        |(pending, mut rx, ended)| async move {
            if ended {
                return None;
            }
            let s = match pending {
                Some(s) => s,
                None => loop {
                    match rx.recv().await {
                        Ok(s) => break s,
                        Err(RecvError::Lagged(_)) => continue,
                        Err(RecvError::Closed) => return None,
                    }
                },
            };
            let ended = !matches!(s.state, JobState::Running);
            let event = Ok(Event::default().json_data(&s).unwrap_or_default());
            Some((event, (None, rx, ended)))
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

async fn repo_meta(State(st): State<Shared>, Path(repo): Path<String>) -> ApiResult<Json<Value>> {
    // A repo whose first extraction hasn't finished has a directory but no meta.json yet.
    if !st.layout.repo_dir(&repo).join("meta.json").exists() {
        return Err(anyhow::anyhow!("repo '{repo}' has not been extracted yet").into());
    }
    let meta = st.layout.read_meta(&repo)?;
    let s = st.clone();
    let r = repo.clone();
    let summary = blocking(move || s.db.summary(&r)).await?;
    Ok(Json(
        json!({ "meta": meta, "summary": summary, "job": st.jobs.running_for(&repo).map(|j| j.status.lock().unwrap().clone()) }),
    ))
}

async fn repo_axis(State(st): State<Shared>, Path(repo): Path<String>) -> ApiResult<Response> {
    Ok(arrow(blocking(move || st.db.axis(&repo)).await?))
}

async fn repo_paths(State(st): State<Shared>, Path(repo): Path<String>) -> ApiResult<Response> {
    Ok(arrow(blocking(move || st.db.paths(&repo)).await?))
}

async fn repo_authors(
    State(st): State<Shared>,
    Path(repo): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(json!(blocking(move || st.db.authors(&repo)).await?)))
}

async fn repo_bars(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (f, b) = (filters(&q), bins(&q)?);
    Ok(arrow(blocking(move || st.db.bars(&repo, &f, &b)).await?))
}

fn area_query(q: &HashMap<String, String>) -> AreaQuery {
    AreaQuery {
        slice: match q.get("slice").map(String::as_str) {
            Some("lang") => Slice::Lang,
            Some("author") => Slice::Author,
            Some("cohort") => Slice::Cohort,
            _ => Slice::Dir,
        },
        mode: if q.get("mode").is_some_and(|m| m == "flow") {
            AreaMode::Flow
        } else {
            AreaMode::Size
        },
        depth: q.get("depth").and_then(|v| v.parse().ok()).unwrap_or(1),
        top: q.get("top").and_then(|v| v.parse().ok()).unwrap_or(12),
        unit: q.get("unit").cloned().unwrap_or_else(|| "year".into()),
    }
}

async fn repo_area(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (f, b, aq) = (filters(&q), bins(&q)?, area_query(&q));
    Ok(arrow(
        blocking(move || st.db.area(&repo, &f, &b, &aq)).await?,
    ))
}

async fn repo_keys(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (f, b, aq) = (filters(&q), bins(&q)?, area_query(&q));
    Ok(arrow(
        blocking(move || st.db.keys(&repo, &f, &b, &aq)).await?,
    ))
}

/// `slice`, `unit`, `keys` (comma-separated), `mode` (size|flow), `from` (exclusive), `to`.
fn composition_query(q: &HashMap<String, String>) -> ApiResult<CompositionQuery> {
    let area = area_query(q);
    Ok(CompositionQuery {
        mode: area.mode,
        keys: q
            .get("keys")
            .map(|v| v.split(',').filter_map(|k| k.trim().parse().ok()).collect())
            .unwrap_or_default(),
        from: q.get("from").and_then(|v| v.parse().ok()).unwrap_or(-1),
        to: num_param::<u32>(q, "to")?,
        area,
    })
}

async fn repo_composition(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (f, cq) = (filters(&q), composition_query(&q)?);
    Ok(arrow(
        blocking(move || st.db.composition(&repo, &f, &cq)).await?,
    ))
}

async fn repo_origins(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (f, cq) = (filters(&q), composition_query(&q)?);
    Ok(arrow(
        blocking(move || st.db.origins(&repo, &f, &cq)).await?,
    ))
}

fn num_param<T: std::str::FromStr>(q: &HashMap<String, String>, k: &str) -> ApiResult<T> {
    q.get(k)
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| ApiError(anyhow::anyhow!("missing or bad '{k}'")))
}

async fn repo_state(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (f, step) = (filters(&q), num_param::<u32>(&q, "step")?);
    Ok(arrow(blocking(move || st.db.state(&repo, step, &f)).await?))
}

async fn repo_events(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (f, from, to) = (
        filters(&q),
        num_param::<i64>(&q, "from")?,
        num_param::<u32>(&q, "to")?,
    );
    Ok(arrow(
        blocking(move || st.db.events(&repo, from, to, &f)).await?,
    ))
}

async fn repo_churn(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (f, from, to) = (
        filters(&q),
        num_param::<i64>(&q, "from")?,
        num_param::<u32>(&q, "to")?,
    );
    Ok(arrow(
        blocking(move || st.db.churn(&repo, from, to, &f)).await?,
    ))
}

async fn repo_span(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (f, from, to) = (
        filters(&q),
        num_param::<u32>(&q, "from")?,
        num_param::<u32>(&q, "to")?,
    );
    Ok(arrow(
        blocking(move || st.db.span(&repo, from, to, &f)).await?,
    ))
}

async fn repo_renames(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (from, to) = (num_param::<u32>(&q, "from")?, num_param::<u32>(&q, "to")?);
    Ok(arrow(
        blocking(move || st.db.renames(&repo, from, to)).await?,
    ))
}

async fn repo_compare(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (f, a, b) = (
        filters(&q),
        num_param::<u32>(&q, "a")?,
        num_param::<u32>(&q, "b")?,
    );
    Ok(arrow(
        blocking(move || st.db.compare(&repo, a, b, &f)).await?,
    ))
}

async fn repo_step(
    State(st): State<Shared>,
    Path((repo, n)): Path<(String, u32)>,
) -> ApiResult<Json<Value>> {
    Ok(Json(blocking(move || st.db.step(&repo, n)).await?))
}

async fn repo_commits(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let f = filters(&q);
    let (first, last) = (
        num_param::<u32>(&q, "first")?,
        num_param::<u32>(&q, "last")?,
    );
    let limit = q
        .get("limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(20u32)
        .min(500);
    Ok(Json(json!(
        blocking(move || st.db.commits(&repo, first, last, &f, limit)).await?
    )))
}

async fn repo_search(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let text = q.get("q").cloned().unwrap_or_default();
    let kind = q.get("kind").cloned().unwrap_or_else(|| "message".into());
    if text.trim().is_empty() {
        return Ok(Json(json!({ "steps": [], "paths": [] })));
    }
    Ok(Json(
        blocking(move || st.db.search(&repo, &text, &kind, 20_000)).await?,
    ))
}

async fn repo_dirs(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let f = filters(&q);
    let parent = q.get("parent").cloned().unwrap_or_default();
    Ok(Json(json!(
        blocking(move || st.db.dirs(&repo, &parent, &f)).await?
    )))
}

async fn static_asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let (file, name) = match Assets::get(path) {
        Some(f) => (f, path),
        // SPA fallback for client-side routes
        None if !path.starts_with("api/") && !path.contains('.') => match Assets::get("index.html")
        {
            Some(f) => (f, "index.html"),
            None => return missing_ui(),
        },
        None => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    let mime = file.metadata.mimetype().to_string();
    let cache = if name == "index.html" {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    let mut resp = (StatusCode::OK, file.data.into_owned()).into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    resp
}

fn missing_ui() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "strata web UI is not built. Run `make web` (or `npm --prefix web run build`), then rebuild strata.",
    )
        .into_response()
}

pub fn router(state: Shared) -> Router {
    let api = Router::new()
        .route("/ping", get(ping))
        .route("/repos", get(list_repos).post(add_repo))
        .route("/jobs/{id}", get(job_status))
        .route("/jobs/{id}/events", get(job_events))
        .route("/jobs/{id}/cancel", post(cancel_job))
        .route("/r/{repo}", delete(delete_repo))
        .route("/r/{repo}/update", post(update_repo))
        .route("/r/{repo}/meta", get(repo_meta))
        .route("/r/{repo}/axis", get(repo_axis))
        .route("/r/{repo}/paths", get(repo_paths))
        .route("/r/{repo}/authors", get(repo_authors))
        .route("/r/{repo}/bars", get(repo_bars))
        .route("/r/{repo}/area", get(repo_area))
        .route("/r/{repo}/keys", get(repo_keys))
        .route("/r/{repo}/composition", get(repo_composition))
        .route("/r/{repo}/origins", get(repo_origins))
        .route("/r/{repo}/state", get(repo_state))
        .route("/r/{repo}/events", get(repo_events))
        .route("/r/{repo}/compare", get(repo_compare))
        .route("/r/{repo}/churn", get(repo_churn))
        .route("/r/{repo}/span", get(repo_span))
        .route("/r/{repo}/renames", get(repo_renames))
        .route("/r/{repo}/step/{n}", get(repo_step))
        .route("/r/{repo}/commits", get(repo_commits))
        .route("/r/{repo}/search", get(repo_search))
        .route("/r/{repo}/dirs", get(repo_dirs))
        .merge(render::routes())
        .route_layer(middleware::from_fn_with_state(state.clone(), touch));
    Router::new()
        .nest("/api", api)
        .fallback(static_asset)
        .layer(tower_http::compression::CompressionLayer::new())
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state)
}

pub struct ServerConfig {
    pub layout: Layout,
    pub port: u16,
    pub host: String,
    pub extract_opts: ExtractOptions,
}

pub fn app_state(cfg: &ServerConfig) -> anyhow::Result<Shared> {
    Ok(Arc::new(AppState {
        db: Db::new(cfg.layout.clone())?,
        layout: cfg.layout.clone(),
        jobs: Arc::new(Jobs::default()),
        extract_opts: cfg.extract_opts.clone(),
        renders: render::Renders::default(),
        last_seen: Mutex::new(Instant::now()),
        shutdown: tokio::sync::Notify::new(),
    }))
}

/// Bind (trying the next ports if taken) and return the address plus the serving future.
pub async fn bind(
    cfg: &ServerConfig,
    state: Shared,
) -> anyhow::Result<(
    SocketAddr,
    impl Future<Output = std::io::Result<()>> + use<>,
)> {
    use tokio::signal::unix::{SignalKind, signal};
    // Closing the terminal (SIGHUP) and SIGTERM stop the server as Ctrl-C does.
    let mut hangup = signal(SignalKind::hangup())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let mut last_err = None;
    for port in cfg.port..cfg.port.saturating_add(20) {
        match tokio::net::TcpListener::bind((cfg.host.as_str(), port)).await {
            Ok(listener) => {
                let addr = listener.local_addr()?;
                let app = router(state.clone());
                let fut = axum::serve(listener, app).with_graceful_shutdown(async move {
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => {}
                        _ = hangup.recv() => {}
                        _ = terminate.recv() => {}
                        _ = state.shutdown.notified() => {}
                    }
                    // Running extractions checkpoint and stop, and their git processes go too.
                    state.jobs.cancel_all();
                });
                return Ok((addr, fut.into_future()));
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(anyhow::anyhow!(
        "could not bind {}:{}: {:?}",
        cfg.host,
        cfg.port,
        last_err
    ))
}
