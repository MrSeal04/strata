//! End-to-end extraction for one source: clone/fetch if remote, load config, run the engine
//! into a `ParquetSink`, write `meta.json`.

use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use serde::Serialize;
use strata_engine::{ExtractOptions, RepoConfig};

use crate::layout::{Layout, RepoMeta, Source};
use crate::sink::ParquetSink;

#[derive(Clone, Debug, Default, Serialize)]
pub struct JobProgress {
    pub phase: String,
    /// Units finished by this job only (steps, or clone percent).
    pub done: u64,
    pub total: u64,
    pub steps_per_sec: f64,
    pub eta_secs: Option<f64>,
    pub message: Option<String>,
}

/// Run a git command, forwarding its progress lines ("Receiving objects:  42% ...") to `progress`.
///
/// git runs in its own session, with no controlling terminal and terminal prompts off, so a
/// server that asks for credentials (or ssh asking about a host key) fails at once instead of
/// waiting on a prompt nobody sees. Setting `cancel` stops the whole process group (git,
/// git-remote-http, ssh): SIGTERM first so git removes its lock files, SIGKILL if that hangs.
fn git_with_progress(
    args: &[&str],
    cwd: Option<&Path>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&JobProgress),
) -> anyhow::Result<()> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    // SAFETY: setsid is async-signal-safe, so it may run between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().context("running git")?;
    let group = child.id() as libc::pid_t;
    let stderr = child.stderr.take().expect("piped");
    let mut tail = Vec::new();
    let finished = AtomicBool::new(false);
    let read = std::thread::scope(|scope| {
        // The reader below blocks on git's stderr, so cancel is watched from here. The child
        // is reaped only after this thread is joined, so its group id cannot be reused.
        scope.spawn(|| {
            while !finished.load(Ordering::Relaxed) {
                if cancel.load(Ordering::Relaxed) {
                    kill_group(group, &finished);
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        let read = read_progress(stderr, &mut tail, progress);
        finished.store(true, Ordering::Relaxed);
        read
    });
    let status = child.wait()?;
    if cancel.load(Ordering::Relaxed) {
        bail!("git {} cancelled", args.join(" "));
    }
    read?;
    if !status.success() {
        let mut msg = format!("git {} failed:\n{}", args.join(" "), tail.join("\n"));
        if tail.iter().any(|l| {
            l.contains("terminal prompts disabled") || l.contains("could not read Username")
        }) {
            msg.push_str(
                "\nThe server wants credentials, and strata cannot prompt for them. Use an SSH URL \
                 with a key the server accepts, or store the credentials in a git credential helper.",
            );
        }
        bail!(msg);
    }
    Ok(())
}

/// SIGTERM the process group, then SIGKILL it if its stderr is still open after 3 s.
fn kill_group(group: libc::pid_t, finished: &AtomicBool) {
    // SAFETY: kill(2) on the group of a child that has not been reaped yet.
    unsafe { libc::kill(-group, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if finished.load(Ordering::Relaxed) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    unsafe { libc::kill(-group, libc::SIGKILL) };
}

/// Forward git's progress lines until its stderr closes, keeping the last 20 for errors.
fn read_progress(
    stderr: impl Read,
    tail: &mut Vec<String>,
    progress: &mut dyn FnMut(&JobProgress),
) -> std::io::Result<()> {
    // git progress uses '\r' to redraw; split on both.
    let mut reader = BufReader::new(stderr);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = read_until_any(&mut reader, &mut buf)?;
        if n == 0 {
            return Ok(());
        }
        let line = String::from_utf8_lossy(&buf).trim().to_string();
        if line.is_empty() {
            continue;
        }
        let pct = line
            .split_whitespace()
            .find_map(|w| w.strip_suffix('%'))
            .and_then(|p| p.parse::<u64>().ok());
        progress(&JobProgress {
            phase: "clone".into(),
            done: pct.unwrap_or(0),
            total: 100,
            message: Some(line.clone()),
            ..Default::default()
        });
        tail.push(line);
        if tail.len() > 20 {
            tail.remove(0);
        }
    }
}

fn read_until_any(r: &mut impl BufRead, out: &mut Vec<u8>) -> std::io::Result<usize> {
    let mut total = 0;
    loop {
        let (done, used) = {
            let available = r.fill_buf()?;
            if available.is_empty() {
                return Ok(total);
            }
            match available.iter().position(|&b| b == b'\n' || b == b'\r') {
                Some(i) => {
                    out.extend_from_slice(&available[..=i]);
                    (true, i + 1)
                }
                None => {
                    out.extend_from_slice(available);
                    (false, available.len())
                }
            }
        };
        r.consume(used);
        total += used;
        if done {
            return Ok(total);
        }
    }
}

/// The git directory to read: the path itself for local repos, a bare mirror for URLs.
pub fn prepare_git_dir(
    layout: &Layout,
    source: &Source,
    fetch: bool,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&JobProgress),
) -> anyhow::Result<PathBuf> {
    match source {
        Source::Path { path } => Ok(path.clone()),
        Source::Url { url } => {
            let dir = layout.clone_dir(url);
            if dir.join("HEAD").exists() {
                if fetch {
                    git_with_progress(
                        &[
                            "fetch",
                            "--progress",
                            "--prune",
                            "--tags",
                            "origin",
                            "+refs/heads/*:refs/heads/*",
                        ],
                        Some(&dir),
                        cancel,
                        progress,
                    )?;
                }
            } else {
                std::fs::create_dir_all(dir.parent().unwrap())?;
                let tmp = dir.with_extension("partial");
                let _ = std::fs::remove_dir_all(&tmp);
                if let Err(e) = git_with_progress(
                    &["clone", "--bare", "--progress", url, &tmp.to_string_lossy()],
                    None,
                    cancel,
                    progress,
                ) {
                    let _ = std::fs::remove_dir_all(&tmp);
                    return Err(e);
                }
                std::fs::rename(&tmp, &dir)?;
            }
            Ok(dir)
        }
    }
}

/// Extract `source` into the cache and return its fresh metadata.
pub fn extract_source(
    layout: &Layout,
    source: &Source,
    opts: &ExtractOptions,
    fetch: bool,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&JobProgress),
) -> anyhow::Result<RepoMeta> {
    let id = source.id();
    let dir = layout.repo_dir(&id);
    std::fs::create_dir_all(&dir)?;
    // One extraction per repo at a time (CLI and server can both start one).
    let lock = std::fs::File::create(dir.join("extract.lock"))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            bail!("another extraction of {} is already running", source.name())
        }
        Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
    }
    let git_dir = prepare_git_dir(layout, source, fetch, cancel, progress)?;
    let repo_cfg = git_dir.join(".strata.toml");
    let cache_cfg = dir.join("strata.toml");
    let cfg = RepoConfig::load(&[&repo_cfg, &cache_cfg])?;
    let mut sink = ParquetSink::new(&dir)?;
    let report = strata_engine::extract(&git_dir, &dir, &cfg, &mut sink, opts, cancel, &mut |p| {
        progress(&JobProgress {
            phase: p.phase.to_string(),
            done: p.done,
            total: p.total,
            steps_per_sec: p.steps_per_sec,
            eta_secs: p.eta_secs,
            message: None,
        })
    })?;
    let meta = RepoMeta {
        id,
        name: source.name(),
        source: source.clone(),
        git_dir,
        branch: report.branch.clone(),
        head: report.head.clone(),
        steps: report.steps_total,
        first_time: report.first_time,
        last_time: report.last_time,
        engine_version: strata_engine::extract::ENGINE_VERSION.to_string(),
        updated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64),
        last_run: serde_json::to_value(&report)?,
    };
    layout.write_meta(&meta)?;
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;

    /// An HTTP server that answers every request with 401, like a private Forgejo repo.
    fn needs_auth_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let _ = stream.read(&mut [0u8; 4096]);
                let _ = stream.write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"t\"\r\n\
                      Content-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });
        format!("http://{addr}/private.git")
    }

    #[test]
    fn credential_prompt_fails_instead_of_waiting() {
        let url = needs_auth_server();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("clone");
        let t0 = Instant::now();
        // An empty credential.helper drops any helper configured on this machine.
        let err = git_with_progress(
            &[
                "-c",
                "credential.helper=",
                "clone",
                "--bare",
                &url,
                &dest.to_string_lossy(),
            ],
            None,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(
            t0.elapsed() < Duration::from_secs(10),
            "took {:?}",
            t0.elapsed()
        );
        assert!(
            format!("{err:#}").contains("strata cannot prompt"),
            "{err:#}"
        );
    }

    #[test]
    fn cancel_stops_git_and_its_helpers() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let server = dir.path().join("server.sh");
        std::fs::write(
            &server,
            format!(
                "#!/bin/sh\necho $$ > {}\nexec sleep 60\n",
                pidfile.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&server, std::fs::Permissions::from_mode(0o755)).unwrap();
        // The ext:: transport runs the script as the remote end, and git waits on it forever.
        let url = format!("ext::{}", server.display());
        let dest = dir.path().join("clone");
        let cancel = AtomicBool::new(false);
        let t0 = Instant::now();
        let res = std::thread::scope(|s| {
            s.spawn(|| {
                while !pidfile.exists() && t0.elapsed() < Duration::from_secs(10) {
                    std::thread::sleep(Duration::from_millis(20));
                }
                std::thread::sleep(Duration::from_millis(200));
                cancel.store(true, Ordering::Relaxed);
            });
            git_with_progress(
                &[
                    "-c",
                    "protocol.ext.allow=always",
                    "clone",
                    "--bare",
                    &url,
                    &dest.to_string_lossy(),
                ],
                None,
                &cancel,
                &mut |_| {},
            )
        });
        let err = res.unwrap_err();
        assert!(format!("{err:#}").contains("cancelled"), "{err:#}");
        assert!(
            t0.elapsed() < Duration::from_secs(10),
            "took {:?}",
            t0.elapsed()
        );
        // The remote end's `sleep` got the signal too, not only git.
        let pid = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .to_string();
        let stat = format!("/proc/{pid}/stat");
        let gone = (0..100).any(|_| {
            let alive = std::fs::read_to_string(&stat).is_ok_and(|s| !s.contains(") Z "));
            if alive {
                std::thread::sleep(Duration::from_millis(50));
            }
            !alive
        });
        assert!(gone, "sleep {pid} outlived the cancel");
    }
}
