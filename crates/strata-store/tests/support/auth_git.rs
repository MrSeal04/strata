//! A private smart-HTTP git server for tests: `git http-backend` behind HTTP basic auth that
//! accepts exactly one login. Shared with strata-server's tests through `#[path]`.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

pub const USER: &str = "alice";
pub const PASS: &str = "s3cret-Pa55-strata-test";

/// Authorized responses wait this long, so a test can look at the git processes mid-clone.
pub const DELAY: Duration = Duration::from_millis(300);

pub struct PrivateRemote {
    pub url: String,
    pub commits: usize,
    _dir: tempfile::TempDir,
}

/// A repo with `commits` commits, served at `http://127.0.0.1:<port>/private.git`.
pub fn private_remote(commits: usize) -> PrivateRemote {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src");
    std::fs::create_dir(&src).unwrap();
    git(&src, &["init", "-q", "-b", "main"]);
    for i in 1..=commits {
        std::fs::write(src.join(format!("f{i}.txt")), "line\n".repeat(i)).unwrap();
        git(&src, &["add", "."]);
        git(&src, &["commit", "-q", "-m", &format!("commit {i}")]);
    }
    let root = dir.path().join("srv");
    std::fs::create_dir(&root).unwrap();
    git(
        dir.path(),
        &["clone", "-q", "--bare", "src", "srv/private.git"],
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/private.git", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let root = root.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, &root);
            });
        }
    });
    PrivateRemote {
        url,
        commits,
        _dir: dir,
    }
}

fn git(dir: &Path, args: &[&str]) {
    let st = Command::new("git")
        .args(["-c", "user.name=T", "-c", "user.email=t@example.com"])
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap();
    assert!(st.success(), "git {args:?}");
}

fn handle(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    loop {
        line.clear();
        reader.read_line(&mut line)?;
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let mut body = Vec::new();
    if let Some(n) = headers.get("content-length") {
        body.resize(n.parse().unwrap_or(0), 0);
        reader.read_exact(&mut body)?;
    } else if headers
        .get("transfer-encoding")
        .is_some_and(|t| t.eq_ignore_ascii_case("chunked"))
    {
        loop {
            line.clear();
            reader.read_line(&mut line)?;
            let n = usize::from_str_radix(line.trim().split(';').next().unwrap_or("0"), 16)
                .unwrap_or(0);
            if n == 0 {
                reader.read_line(&mut line)?;
                break;
            }
            let mut chunk = vec![0; n + 2]; // data plus its CRLF
            reader.read_exact(&mut chunk)?;
            body.extend_from_slice(&chunk[..n]);
        }
    }
    let expected = format!("Basic {}", base64(format!("{USER}:{PASS}").as_bytes()));
    if headers.get("authorization") != Some(&expected) {
        stream.write_all(
            b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"test\"\r\n\
              Content-Length: 0\r\nConnection: close\r\n\r\n",
        )?;
        return Ok(());
    }
    std::thread::sleep(DELAY);
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let mut cgi = Command::new("git");
    cgi.arg("http-backend")
        .env("GIT_PROJECT_ROOT", root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("PATH_INFO", path)
        .env("QUERY_STRING", query)
        .env("REQUEST_METHOD", &method)
        .env(
            "CONTENT_TYPE",
            headers.get("content-type").map_or("", |s| s),
        )
        .env("CONTENT_LENGTH", body.len().to_string())
        .env("REMOTE_USER", USER)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(p) = headers.get("git-protocol") {
        cgi.env("GIT_PROTOCOL", p);
    }
    if let Some(e) = headers.get("content-encoding") {
        cgi.env("HTTP_CONTENT_ENCODING", e);
    }
    let mut child = cgi.spawn()?;
    child.stdin.take().unwrap().write_all(&body)?;
    let out = child.wait_with_output()?.stdout;
    // CGI output: header lines, a blank line, then the body.
    let (head_len, sep) = match out.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(i) => (i, 4),
        None => (
            out.windows(2)
                .position(|w| w == b"\n\n")
                .unwrap_or(out.len()),
            2,
        ),
    };
    let head = String::from_utf8_lossy(&out[..head_len]);
    let rest = out.get(head_len + sep..).unwrap_or_default();
    let mut status = "200 OK".to_string();
    let mut extra = String::new();
    for l in head.lines() {
        match l.strip_prefix("Status: ") {
            Some(s) => status = s.to_string(),
            None => extra.push_str(&format!("{}\r\n", l.trim_end())),
        }
    }
    write!(
        stream,
        "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
        rest.len()
    )?;
    stream.write_all(rest)
}

fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Every process whose command line contains `needle`, other than this test process.
pub fn argv_holding(needle: &str) -> Vec<(u32, String)> {
    let me = std::process::id();
    let mut hits = Vec::new();
    for e in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        if pid == me {
            continue;
        }
        if let Ok(raw) = std::fs::read(e.path().join("cmdline")) {
            let cmd = String::from_utf8_lossy(&raw).replace('\0', " ");
            if cmd.contains(needle) {
                hits.push((pid, cmd));
            }
        }
    }
    hits
}
