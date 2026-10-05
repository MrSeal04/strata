//! API responses are compressed for other hosts but not for local requests, where gzip cost far
//! more than it saved.

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, header};
use strata_engine::ExtractOptions;
use strata_server::{ServerConfig, app_state, bind, router};
use strata_store::Layout;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;

/// An API path whose (error) reply is large enough to be worth compressing.
fn uri() -> String {
    format!("/api/r/{}/meta", "x".repeat(200))
}

fn config(home: &std::path::Path) -> ServerConfig {
    ServerConfig {
        layout: Layout::new(home.to_path_buf()),
        port: 0,
        host: "127.0.0.1".into(),
        extract_opts: ExtractOptions::default(),
    }
}

/// The `Content-Encoding` of a gzip-accepting request from `peer` (None: no peer address known).
async fn encoding(peer: Option<SocketAddr>) -> Option<String> {
    let home = tempfile::tempdir().unwrap();
    let app = router(app_state(&config(home.path())).unwrap());
    let mut req = Request::get(uri())
        .header(header::ACCEPT_ENCODING, "gzip, deflate, br, zstd")
        .body(Body::empty())
        .unwrap();
    if let Some(peer) = peer {
        req.extensions_mut().insert(ConnectInfo(peer));
    }
    let resp = app.oneshot(req).await.unwrap();
    resp.headers()
        .get(header::CONTENT_ENCODING)
        .map(|v| v.to_str().unwrap().to_string())
}

#[tokio::test]
async fn only_remote_requests_are_compressed() {
    let local: SocketAddr = "127.0.0.1:5000".parse().unwrap();
    let local6: SocketAddr = "[::1]:5000".parse().unwrap();
    let mapped: SocketAddr = "[::ffff:127.0.0.1]:5000".parse().unwrap();
    let remote: SocketAddr = "192.0.2.10:5000".parse().unwrap();
    assert_eq!(encoding(Some(local)).await, None);
    assert_eq!(encoding(Some(local6)).await, None);
    assert_eq!(encoding(Some(mapped)).await, None);
    assert_eq!(encoding(Some(remote)).await.as_deref(), Some("gzip"));
    // Without a peer address (a router used directly), nothing changes.
    assert_eq!(encoding(None).await.as_deref(), Some("gzip"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_bound_server_knows_its_requests_are_local() {
    let home = tempfile::tempdir().unwrap();
    let cfg = config(home.path());
    let (addr, server) = bind(&cfg, app_state(&cfg).unwrap()).await.unwrap();
    let server = tokio::spawn(server);
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "GET {} HTTP/1.0\r\nHost: x\r\nAccept-Encoding: gzip\r\n\r\n",
        uri()
    );
    conn.write_all(req.as_bytes()).await.unwrap();
    let mut reply = Vec::new();
    conn.read_to_end(&mut reply).await.unwrap();
    let reply = String::from_utf8_lossy(&reply).to_ascii_lowercase();
    assert!(reply.contains("not been extracted"), "{reply}");
    assert!(!reply.contains("content-encoding"), "{reply}");
    server.abort();
}
