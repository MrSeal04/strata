//! strata HTTP server: JSON/Arrow API over the store, extraction jobs with SSE progress, and the
//! embedded web UI.

pub mod jobs;
pub mod render;

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::Stream;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{Value, json};
use strata_engine::ExtractOptions;
use strata_store::pipeline::Credentials;
use strata_store::{AreaMode, AreaQuery, Axis, Bins, Db, Filters, Layout, Slice, Source};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

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
        let status = if msg.contains("not been extracted") || msg.contains("not found") {
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

async fn list_repos(State(st): State<Shared>) -> Json<Value> {
    let repos = st.layout.list();
    Json(json!({ "repos": repos, "jobs": st.jobs.all() }))
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
    let finished = !matches!(first.state, JobState::Running);
    let head = tokio_stream::once(first);
    let rest = BroadcastStream::new(rx).filter_map(Result::ok);
    let stream = head
        .chain(rest)
        .map(|s| Ok(Event::default().json_data(&s).unwrap_or_default()));
    let stream: std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> =
        if finished {
            Box::pin(stream.take(1))
        } else {
            Box::pin(stream)
        };
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

async fn repo_area(
    State(st): State<Shared>,
    Path(repo): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (f, b) = (filters(&q), bins(&q)?);
    let aq = AreaQuery {
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
    };
    Ok(arrow(
        blocking(move || st.db.area(&repo, &f, &b, &aq)).await?,
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
        .route("/repos", get(list_repos).post(add_repo))
        .route("/jobs/{id}", get(job_status))
        .route("/jobs/{id}/events", get(job_events))
        .route("/jobs/{id}/cancel", post(cancel_job))
        .route("/r/{repo}/meta", get(repo_meta))
        .route("/r/{repo}/axis", get(repo_axis))
        .route("/r/{repo}/paths", get(repo_paths))
        .route("/r/{repo}/authors", get(repo_authors))
        .route("/r/{repo}/bars", get(repo_bars))
        .route("/r/{repo}/area", get(repo_area))
        .route("/r/{repo}/state", get(repo_state))
        .route("/r/{repo}/events", get(repo_events))
        .route("/r/{repo}/compare", get(repo_compare))
        .route("/r/{repo}/step/{n}", get(repo_step))
        .route("/r/{repo}/commits", get(repo_commits))
        .route("/r/{repo}/search", get(repo_search))
        .route("/r/{repo}/dirs", get(repo_dirs))
        .merge(render::routes());
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
    let mut last_err = None;
    for port in cfg.port..cfg.port.saturating_add(20) {
        match tokio::net::TcpListener::bind((cfg.host.as_str(), port)).await {
            Ok(listener) => {
                let addr = listener.local_addr()?;
                let app = router(state);
                let fut = axum::serve(listener, app).with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
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
