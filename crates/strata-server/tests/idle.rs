//! A server started from the app launcher stops once no page has called the API for a while, but
//! never while an extraction runs.

use std::net::{SocketAddr, TcpListener};
use std::time::{Duration, Instant};

use strata_engine::ExtractOptions;
use strata_server::{ServerConfig, app_state, bind, exit_when_idle};
use strata_store::{Layout, Source};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn get(addr: SocketAddr, path: &str) -> String {
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    conn.write_all(format!("GET {path} HTTP/1.0\r\nHost: x\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut reply = String::new();
    conn.read_to_string(&mut reply).await.unwrap();
    reply
}

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
async fn stops_when_idle_but_not_during_an_extraction() {
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
    let idle = Duration::from_secs(1);
    exit_when_idle(state.clone(), idle);

    // An open page pings: the server stays up well past `idle`.
    let until = Instant::now() + idle * 2;
    while Instant::now() < until {
        assert!(get(addr, "/api/ping").await.contains(r#""app":"strata""#));
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!server.is_finished(), "stopped while a page pinged");

    // No page, but an extraction is running.
    let job = state.jobs.start(
        layout,
        Source::parse(&silent_remote()).unwrap(),
        ExtractOptions::default(),
        true,
        None,
        |_| {},
    );
    tokio::time::sleep(idle * 3).await;
    assert!(state.jobs.any_running());
    assert!(!server.is_finished(), "stopped during an extraction");

    // Once it ends, nothing holds the server up.
    job.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    tokio::time::timeout(Duration::from_secs(15), server)
        .await
        .expect("server stopped after the extraction ended")
        .unwrap()
        .unwrap();
}
