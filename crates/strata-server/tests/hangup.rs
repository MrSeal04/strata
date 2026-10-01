//! Closing the terminal strata runs in (SIGHUP) stops it as Ctrl-C does: a running extraction is
//! cancelled and its git killed, and a page watching that extraction doesn't hold the server open.
//! Its own test binary, since the signal goes to the whole process.

#[path = "../../strata-store/tests/support/auth_git.rs"]
mod auth_git;

use std::net::TcpListener;
use std::time::{Duration, Instant};

use strata_engine::ExtractOptions;
use strata_server::{ServerConfig, app_state, bind};
use strata_store::{Layout, Source};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A git remote that accepts connections and never answers, so a clone hangs until cancelled.
fn silent_remote() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/repo.git", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let held: Vec<_> = listener.incoming().flatten().collect();
        drop(held);
    });
    url
}

#[tokio::test(flavor = "multi_thread")]
async fn hangup_cancels_extractions_and_stops() {
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().to_path_buf());
    let cfg = ServerConfig {
        layout: layout.clone(),
        port: 0,
        host: "127.0.0.1".into(),
        extract_opts: ExtractOptions::default(),
    };
    let state = app_state(&cfg).unwrap();
    let (addr, server) = bind(&cfg, state.clone()).await.unwrap();
    let server = tokio::spawn(server);

    let url = silent_remote();
    let job = state.jobs.start(
        layout,
        Source::parse(&url).unwrap(),
        ExtractOptions::default(),
        true,
        None,
        |_| {},
    );
    let until = Instant::now() + Duration::from_secs(10);
    while auth_git::argv_holding(&url).is_empty() {
        assert!(Instant::now() < until, "git never started");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // A loading page follows the extraction's progress.
    let mut page = tokio::net::TcpStream::connect(addr).await.unwrap();
    let id = job.status.lock().unwrap().id.clone();
    page.write_all(format!("GET /api/jobs/{id}/events HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut head = [0u8; 256];
    let n = page.read(&mut head).await.unwrap();
    assert!(String::from_utf8_lossy(&head[..n]).contains("200 OK"));

    let kill = std::process::Command::new("kill")
        .args(["-HUP", &std::process::id().to_string()])
        .status()
        .unwrap();
    assert!(kill.success());
    tokio::time::timeout(Duration::from_secs(15), server)
        .await
        .expect("the server stopped")
        .unwrap()
        .unwrap();

    let until = Instant::now() + Duration::from_secs(10);
    while state.jobs.any_running() || !auth_git::argv_holding(&url).is_empty() {
        assert!(
            Instant::now() < until,
            "left running: {:?}",
            auth_git::argv_holding(&url)
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let state_json = serde_json::to_value(job.status.lock().unwrap().clone()).unwrap();
    assert_eq!(state_json["state"], "cancelled");
}
