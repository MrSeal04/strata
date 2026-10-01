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

/// A login for an HTTP(S) remote, kept in memory only. git receives it from a one-off
/// credential helper that reads two environment variables, so it never reaches argv (which
/// other local users can read), the URL, the clone's config or the cache.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

impl Credentials {
    /// Checks the login fits git's credential protocol, which carries one line per value.
    pub fn new(username: &str, password: &str) -> anyhow::Result<Self> {
        if username.is_empty() || password.is_empty() {
            bail!("enter both a username and a password or access token");
        }
        if [username, password]
            .iter()
            .any(|v| v.contains(['\n', '\r', '\0']))
        {
            bail!("the username and password cannot contain line breaks");
        }
        Ok(Self {
            username: username.to_string(),
            password: password.to_string(),
        })
    }
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("username", &self.username)
            .finish_non_exhaustive()
    }
}

/// The remote wants a login that strata doesn't have, or refused the one it sent.
#[derive(Debug)]
pub struct AuthRequired {
    /// `scheme://host[:port]` of the remote, for the prompt.
    pub host: String,
    /// A login was sent and the server refused it.
    pub rejected: bool,
}

impl std::fmt::Display for AuthRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.rejected {
            write!(f, "{} rejected the login", self.host)
        } else {
            write!(
                f,
                "{} wants a login: enter it in the dashboard or run strata in a terminal, \
                 or use an SSH URL",
                self.host
            )
        }
    }
}

impl std::error::Error for AuthRequired {}

/// The `AuthRequired` anywhere in an error's chain.
pub fn auth_required(e: &anyhow::Error) -> Option<&AuthRequired> {
    e.chain().find_map(|c| c.downcast_ref::<AuthRequired>())
}

/// An extraction of the repo is running (here or in another strata process).
#[derive(Debug)]
pub struct Busy {
    pub name: String,
}

impl std::fmt::Display for Busy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "another extraction of {} is already running", self.name)
    }
}

impl std::error::Error for Busy {}

/// Take the repo's extraction lock (held until the file is dropped), or fail with `Busy`.
fn lock_repo(dir: &Path, name: &str) -> anyhow::Result<std::fs::File> {
    let lock = std::fs::File::create(dir.join("extract.lock"))?;
    match lock.try_lock() {
        Ok(()) => Ok(lock),
        Err(std::fs::TryLockError::WouldBlock) => Err(Busy {
            name: name.to_string(),
        }
        .into()),
        Err(std::fs::TryLockError::Error(e)) => Err(e.into()),
    }
}

/// `scheme://host[:port]` of a remote URL, without any user info.
fn remote_host(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("", url));
    let authority = rest.split('/').next().unwrap_or(rest);
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if scheme.is_empty() {
        host.to_string()
    } else {
        format!("{scheme}://{host}")
    }
}

/// Answers git's `get` with the login in `STRATA_GIT_USERNAME` / `STRATA_GIT_PASSWORD`.
const CREDENTIAL_HELPER: &str = "credential.helper=!f() { test \"$1\" = get && \
     printf 'username=%s\\npassword=%s\\n' \"$STRATA_GIT_USERNAME\" \"$STRATA_GIT_PASSWORD\"; }; f";

/// Run a git command, forwarding its progress lines ("Receiving objects:  42% ...") to `progress`.
///
/// git runs in its own session, with no controlling terminal and terminal prompts off, so a
/// server that asks for credentials (or ssh asking about a host key) fails at once instead of
/// waiting on a prompt nobody sees; that failure comes back as `AuthRequired` for `url`, so the
/// caller can ask for a login and retry with `login`. Setting `cancel` stops the whole process
/// group (git, git-remote-http, ssh): SIGTERM first so git removes its lock files, SIGKILL if
/// that hangs.
fn git_with_progress(
    args: &[&str],
    cwd: Option<&Path>,
    url: &str,
    login: Option<&Credentials>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&JobProgress),
) -> anyhow::Result<()> {
    let mut cmd = Command::new("git");
    if let Some(c) = login {
        // The empty helper clears any configured ones, so git uses this login and stores it nowhere.
        cmd.args(["-c", "credential.helper=", "-c", CREDENTIAL_HELPER])
            .env("STRATA_GIT_USERNAME", &c.username)
            .env("STRATA_GIT_PASSWORD", &c.password);
    }
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
        let wants_login = tail.iter().any(|l| {
            l.contains("could not read Username")
                || l.contains("could not read Password")
                || l.contains("Authentication failed for")
        });
        if wants_login {
            return Err(AuthRequired {
                host: remote_host(url),
                rejected: login.is_some(),
            }
            .into());
        }
        bail!("git {} failed:\n{}", args.join(" "), tail.join("\n"));
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
    login: Option<&Credentials>,
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
                        url,
                        login,
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
                    url,
                    login,
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

/// Extract `source` into the cache and return its fresh metadata. `login` is for private HTTP(S)
/// remotes; without it they fail with `AuthRequired`.
pub fn extract_source(
    layout: &Layout,
    source: &Source,
    opts: &ExtractOptions,
    fetch: bool,
    login: Option<&Credentials>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&JobProgress),
) -> anyhow::Result<RepoMeta> {
    let id = source.id();
    let dir = layout.repo_dir(&id);
    std::fs::create_dir_all(&dir)?;
    // One extraction per repo at a time (CLI and server can both start one).
    let _lock = lock_repo(&dir, &source.name())?;
    let git_dir = prepare_git_dir(layout, source, fetch, login, cancel, progress)?;
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

/// Delete a cached repo: its tables, checkpoint and `meta.json`, and for a remote its clone unless
/// another cached repo reads the same one. A local source's own repository is never touched.
/// Fails with `Busy` while an extraction of it runs. Returns the directories removed.
pub fn remove_repo(layout: &Layout, id: &str) -> anyhow::Result<Vec<PathBuf>> {
    // The id comes from a URL: only a plain cache directory name may reach `repo_dir`.
    let safe = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    let meta = layout
        .read_meta(id)
        .ok()
        .filter(|m| safe && m.id == id)
        .with_context(|| format!("repo '{id}' not found"))?;
    let dir = layout.repo_dir(id);
    let _lock = lock_repo(&dir, &meta.name)?;
    std::fs::remove_dir_all(&dir).with_context(|| format!("removing {}", dir.display()))?;
    let mut removed = vec![dir];
    if let Source::Url { url } = &meta.source {
        // `clone_dir` drops the scheme and user, so two cached URLs can share one clone.
        let clone = layout.clone_dir(url);
        anyhow::ensure!(
            clone.starts_with(layout.root.join("clones")),
            "{} is outside the cache",
            clone.display()
        );
        let shared = layout
            .list()
            .iter()
            .any(|m| matches!(&m.source, Source::Url { url } if layout.clone_dir(url) == clone));
        if !shared && clone.exists() {
            std::fs::remove_dir_all(&clone)
                .with_context(|| format!("removing {}", clone.display()))?;
            removed.push(clone);
        }
    }
    Ok(removed)
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
    fn login_prompt_fails_fast_as_auth_required() {
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
            &url,
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
        let auth = auth_required(&err).unwrap_or_else(|| panic!("not AuthRequired: {err:#}"));
        assert_eq!(auth.host, remote_host(&url));
        assert!(!auth.rejected);
    }

    #[test]
    fn remote_host_drops_path_and_user_info() {
        assert_eq!(
            remote_host("http://git.example.com:3000/you/other.git"),
            "http://git.example.com:3000"
        );
        assert_eq!(
            remote_host("https://bob:pw@github.com/org/repo"),
            "https://github.com"
        );
        assert_eq!(remote_host("host.example"), "host.example");
    }

    #[test]
    fn credentials_are_validated_and_never_debug_printed() {
        assert!(Credentials::new("", "pw").is_err());
        assert!(Credentials::new("bob", "").is_err());
        assert!(Credentials::new("bob", "pw\nusername=eve").is_err());
        let c = Credentials::new("bob", "hunter2-secret").unwrap();
        let shown = format!("{c:?}");
        assert!(
            shown.contains("bob") && !shown.contains("hunter2"),
            "{shown}"
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
                &url,
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
