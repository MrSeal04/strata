//! Headless video rendering: the page (opened with `?render=<token>`) fetches its spec, paints
//! frames deterministically and POSTs them as PNG; the server pipes them into ffmpeg.

use std::collections::HashMap;
use std::io::Write;
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::{ApiResult, AppState};

#[derive(Clone, Debug, PartialEq)]
pub enum RenderState {
    Running,
    Done,
    Failed(String),
}

pub struct RenderJob {
    /// `{ "spec": RenderSpec, "settings": {...} }`, served to the page.
    pub spec: Value,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pub frames: AtomicU64,
    pub total: AtomicU64,
    pub state: Mutex<RenderState>,
}

impl RenderJob {
    pub fn new(spec: Value, mut ffmpeg: Child) -> Self {
        let stdin = ffmpeg.stdin.take();
        Self {
            spec,
            stdin: Mutex::new(stdin),
            child: Mutex::new(Some(ffmpeg)),
            frames: AtomicU64::new(0),
            total: AtomicU64::new(0),
            state: Mutex::new(RenderState::Running),
        }
    }

    fn fail(&self, msg: String) {
        self.stdin.lock().unwrap().take();
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        *self.state.lock().unwrap() = RenderState::Failed(msg);
    }

    /// Close ffmpeg's input and wait for it to finish writing the file.
    fn finish(&self) {
        self.stdin.lock().unwrap().take();
        let child = self.child.lock().unwrap().take();
        let state = match child.map(|c| c.wait_with_output()) {
            Some(Ok(out)) if out.status.success() => RenderState::Done,
            Some(Ok(out)) => RenderState::Failed(format!(
                "ffmpeg exited with {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
                    .lines()
                    .rev()
                    .take(8)
                    .collect::<Vec<_>>()
                    .join("\n")
            )),
            Some(Err(e)) => RenderState::Failed(format!("ffmpeg: {e}")),
            None => RenderState::Failed("render already finished".into()),
        };
        *self.state.lock().unwrap() = state;
    }
}

#[derive(Default)]
pub struct Renders {
    jobs: Mutex<HashMap<String, Arc<RenderJob>>>,
}

impl Renders {
    pub fn add(&self, token: &str, job: RenderJob) -> Arc<RenderJob> {
        let job = Arc::new(job);
        self.jobs
            .lock()
            .unwrap()
            .insert(token.to_string(), job.clone());
        job
    }

    pub fn get(&self, token: &str) -> Option<Arc<RenderJob>> {
        self.jobs.lock().unwrap().get(token).cloned()
    }
}

fn job(st: &AppState, token: &str) -> ApiResult<Arc<RenderJob>> {
    Ok(st
        .renders
        .get(token)
        .ok_or_else(|| anyhow::anyhow!("render job not found"))?)
}

async fn spec(
    State(st): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(job(&st, &token)?.spec.clone()))
}

async fn frame(
    State(st): State<Arc<AppState>>,
    Path(token): Path<String>,
    Query(q): Query<HashMap<String, u64>>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let j = job(&st, &token)?;
    if let Some(t) = q.get("total") {
        j.total.store(*t, Ordering::Relaxed);
    }
    let j2 = j.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let mut guard = j2.stdin.lock().unwrap();
        let stdin = guard
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("ffmpeg input is closed"))?;
        stdin.write_all(&body)?;
        Ok(())
    })
    .await??;
    j.frames.fetch_add(1, Ordering::Relaxed);
    Ok(Json(json!({ "ok": true })))
}

async fn done(
    State(st): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> ApiResult<Json<Value>> {
    let j = job(&st, &token)?;
    tokio::task::spawn_blocking(move || j.finish()).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn error(
    State(st): State<Arc<AppState>>,
    Path(token): Path<String>,
    body: String,
) -> ApiResult<Json<Value>> {
    job(&st, &token)?.fail(format!("page reported: {body}"));
    Ok(Json(json!({ "ok": true })))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/render/{token}", get(spec))
        .route("/render/{token}/frame", post(frame))
        .route("/render/{token}/done", post(done))
        .route("/render/{token}/error", post(error))
        // PNG frames at 2x can exceed axum's default 2 MB body limit.
        .layer(axum::extract::DefaultBodyLimit::max(128 << 20))
}
