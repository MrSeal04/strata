//! Managing cached repos from the dashboard: `POST /api/r/{id}/update` re-extracts on the cached
//! branch, and `DELETE /api/r/{id}` removes the cache but refuses while an extraction runs and
//! accepts only real ids.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use strata_engine::ExtractOptions;
use strata_server::{ServerConfig, app_state, router};
use strata_store::Layout;
use tower::ServiceExt;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "A")
        .env("GIT_AUTHOR_EMAIL", "a@example.com")
        .env("GIT_COMMITTER_NAME", "A")
        .env("GIT_COMMITTER_EMAIL", "a@example.com")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {out:?}");
}

fn commit(dir: &Path, file: &str, msg: &str) {
    std::fs::write(dir.join(file), format!("{msg}\n")).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", msg]);
}

async fn call(app: &Router, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(v) => {
            req = req.header("content-type", "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    let resp = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// Wait for a job to stop and return its final status.
async fn finish(app: &Router, job: &Value) -> Value {
    let id = job["id"].as_str().unwrap();
    for _ in 0..600 {
        let (_, s) = call(app, Method::GET, &format!("/api/jobs/{id}"), None).await;
        if s["state"] != "running" {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("job {id} did not finish");
}

#[tokio::test(flavor = "multi_thread")]
async fn update_and_delete_a_cached_repo() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    git(&src, &["init", "-q", "-b", "main"]);
    commit(&src, "a.txt", "c1");
    commit(&src, "a.txt", "c2");
    let layout = Layout::new(tmp.path().join("home"));
    let app = router(
        app_state(&ServerConfig {
            layout: layout.clone(),
            port: 0,
            host: "127.0.0.1".into(),
            extract_opts: ExtractOptions::default(),
        })
        .unwrap(),
    );

    let (st, job) = call(
        &app,
        Method::POST,
        "/api/repos",
        Some(serde_json::json!({ "source": src.to_str().unwrap() })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let id = finish(&app, &job).await["repo"]
        .as_str()
        .unwrap()
        .to_string();
    let (_, list) = call(&app, Method::GET, "/api/repos", None).await;
    assert_eq!(list["repos"][0]["id"], id.as_str());
    assert!(list["repos"][0]["disk_bytes"].as_u64().unwrap() > 0);
    // Load the tables into the server's DuckDB.
    let (st, _) = call(&app, Method::GET, &format!("/api/r/{id}/meta"), None).await;
    assert_eq!(st, StatusCode::OK);

    // The work tree moves to a feature branch and main gains a commit: an update follows main.
    git(&src, &["checkout", "-q", "-b", "feature"]);
    commit(&src, "b.txt", "on feature");
    git(&src, &["checkout", "-q", "main"]);
    commit(&src, "a.txt", "c3");
    git(&src, &["checkout", "-q", "feature"]);
    let (st, job) = call(&app, Method::POST, &format!("/api/r/{id}/update"), None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(finish(&app, &job).await["state"], "done");
    let meta = layout.read_meta(&id).unwrap();
    assert_eq!((meta.branch.as_str(), meta.steps), ("main", 3));
    assert_eq!(
        meta.last_run["full_reason"],
        Value::Null,
        "{:?}",
        meta.last_run
    );
    let (st, _) = call(&app, Method::POST, "/api/r/nope-00000000/update", None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // Another process extracting it holds the lock.
    let lock = std::fs::File::create(layout.repo_dir(&id).join("extract.lock")).unwrap();
    lock.try_lock().unwrap();
    let (st, body) = call(&app, Method::DELETE, &format!("/api/r/{id}"), None).await;
    assert_eq!(st, StatusCode::CONFLICT, "{body}");
    drop(lock);

    for bad in ["..", "%2E%2E", "..%2Fhome", "nope-00000000"] {
        let (st, _) = call(&app, Method::DELETE, &format!("/api/r/{bad}"), None).await;
        assert!(
            st == StatusCode::NOT_FOUND || st == StatusCode::METHOD_NOT_ALLOWED,
            "{bad}: {st}"
        );
    }
    assert!(layout.repo_dir(&id).join("meta.json").exists());

    let (st, _) = call(&app, Method::DELETE, &format!("/api/r/{id}"), None).await;
    assert_eq!(st, StatusCode::OK);
    assert!(!layout.repo_dir(&id).exists());
    let (st, _) = call(&app, Method::GET, &format!("/api/r/{id}/meta"), None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (_, list) = call(&app, Method::GET, "/api/repos", None).await;
    assert_eq!(list["repos"], serde_json::json!([]));
    assert!(src.join(".git/HEAD").exists());
}
