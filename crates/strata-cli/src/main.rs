//! `strata`: see how a git repository grew over time.

mod bench;
mod login;
mod progress;
mod render;

use std::io::IsTerminal;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use clap::{Args, Parser, Subcommand, ValueEnum};
use strata_engine::ExtractOptions;
use strata_engine::diff::DiffOptions;
use strata_server::ServerConfig;
use strata_server::jobs::JobState;
use strata_store::pipeline::{auth_required, extract_source};
use strata_store::{Layout, Source};

#[derive(Parser)]
#[command(
    name = "strata",
    version,
    about = "See how a git repository grew over time",
    args_conflicts_with_subcommands = true
)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
    /// Repo directory or git URL: extract it (incrementally), serve, and open the browser.
    source: Option<String>,
    #[command(flatten)]
    extract: ExtractArgs,
    #[command(flatten)]
    serve: ServeArgs,
    /// Cache directory (default: $STRATA_HOME or ~/.cache/strata)
    #[arg(long, global = true)]
    home: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Extract a repo's history into the cache without serving.
    Extract {
        source: String,
        #[command(flatten)]
        args: ExtractArgs,
    },
    /// Serve every cached repo (the UI has a repo picker and an "add URL" box).
    Serve(ServeArgs),
    /// Open the dashboard from the app launcher: in the strata server already running, or in a
    /// new one that runs until its terminal window is closed.
    App {
        #[arg(long, default_value_t = 7420)]
        port: u16,
        /// Stop 10 minutes after the last dashboard tab closes instead (for a launcher without
        /// a terminal)
        #[arg(long)]
        exit_when_idle: bool,
        #[arg(long, default_value_t = 600, hide = true)]
        idle_secs: u64,
    },
    /// List cached repos.
    List,
    /// Delete cached repos (and their clones) not updated for a while.
    Gc {
        /// Age in days
        #[arg(long, default_value_t = 90)]
        older_than: u64,
        /// Only print what would be deleted
        #[arg(long)]
        dry_run: bool,
    },
    /// Render a playback video (MP4/GIF) headlessly.
    Render(render::RenderArgs),
    /// Time extraction and every query endpoint on a repo.
    Bench(bench::BenchArgs),
}

#[derive(Clone, Copy, ValueEnum, PartialEq, Eq)]
enum ProgressMode {
    Bar,
    Json,
    None,
}

#[derive(Clone, Copy, ValueEnum)]
enum Attribution {
    /// Credit lines a merge brings in to the side-branch commits that wrote them (git blame)
    Blame,
    /// Credit them to the merge commit's author (faster on huge merge-heavy histories)
    Merger,
}

#[derive(Clone, Copy, ValueEnum)]
enum Ws {
    /// A whitespace-only change doesn't make lines new (default)
    Ignore,
    Strict,
}

#[derive(Args, Clone)]
struct ExtractArgs {
    /// Ignore the checkpoint and re-extract everything
    #[arg(long)]
    full: bool,
    /// Branch to follow (default: HEAD / the remote's default branch)
    #[arg(long)]
    branch: Option<String>,
    /// Diff worker threads (default: CPUs - 1)
    #[arg(long)]
    threads: Option<usize>,
    /// How survival treats whitespace-only edits
    #[arg(long, value_enum, default_value = "ignore")]
    survival_ws: Ws,
    /// Who gets credit for lines that arrive through a merge
    #[arg(long, value_enum, default_value = "blame")]
    merge_attribution: Attribution,
    /// Files larger than this (MB) get approximate counts instead of a line diff
    #[arg(long, default_value_t = 16)]
    max_diff_mb: u64,
    /// Progress output on stderr
    #[arg(long, value_enum, default_value = "bar")]
    progress: ProgressMode,
    /// Don't fetch before extracting a URL that is already cloned
    #[arg(long)]
    no_fetch: bool,
}

#[derive(Args, Clone)]
struct ServeArgs {
    #[arg(long, default_value_t = 7420)]
    port: u16,
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    /// Don't open a browser
    #[arg(long)]
    no_open: bool,
}

impl ExtractArgs {
    fn options(&self) -> ExtractOptions {
        let mut o = ExtractOptions {
            branch: self.branch.clone(),
            full: self.full,
            diff: DiffOptions {
                max_diff_bytes: self.max_diff_mb << 20,
                survival_ws_ignore: matches!(self.survival_ws, Ws::Ignore),
                merge_blame: matches!(self.merge_attribution, Attribution::Blame),
                ..Default::default()
            },
            ..Default::default()
        };
        if let Some(t) = self.threads {
            o.threads = t.max(1);
        }
        o
    }
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("STRATA_LOG")
                .unwrap_or_else(|_| "warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    let layout = Layout::new(cli.home.clone().unwrap_or_else(Layout::default_root));
    match cli.cmd {
        Some(Cmd::Extract { source, args }) => cmd_extract(&layout, &source, &args),
        Some(Cmd::Serve(s)) => serve(layout, None, &cli.extract, &s, Stop::CtrlC),
        Some(Cmd::App {
            port,
            exit_when_idle,
            idle_secs,
        }) => {
            let stop = if exit_when_idle {
                Stop::Idle(Duration::from_secs(idle_secs))
            } else {
                Stop::Window
            };
            cmd_app(layout, &cli.extract, port, stop)
        }
        Some(Cmd::List) => cmd_list(&layout),
        Some(Cmd::Gc {
            older_than,
            dry_run,
        }) => cmd_gc(&layout, older_than, dry_run),
        Some(Cmd::Render(r)) => render::run(layout, r),
        Some(Cmd::Bench(b)) => bench::run(layout, b),
        None => serve(
            layout,
            cli.source.as_deref(),
            &cli.extract,
            &cli.serve,
            Stop::CtrlC,
        ),
    }
}

/// Ctrl-C / SIGTERM: ask the engine to checkpoint and stop (a second signal exits at once).
static CANCEL: AtomicBool = AtomicBool::new(false);

fn handle_signals() {
    let _ = ctrlc::set_handler(|| {
        if CANCEL.swap(true, std::sync::atomic::Ordering::SeqCst) {
            login::restore_terminal();
            std::process::exit(130);
        }
        eprintln!("\nstopping after the current step (checkpointing)…");
    });
}

fn cmd_extract(layout: &Layout, source: &str, args: &ExtractArgs) -> anyhow::Result<()> {
    handle_signals();
    let source = Source::parse(source)?;
    let mut reporter = progress::Reporter::new(
        args.progress == ProgressMode::Json,
        args.progress == ProgressMode::None,
    );
    // A private HTTP remote gets up to three tries at a login typed in the terminal.
    let mut login = None;
    let mut tries = 0;
    let meta = loop {
        let result = extract_source(
            layout,
            &source,
            &args.options(),
            !args.no_fetch,
            login.as_ref(),
            &CANCEL,
            &mut |p| reporter.update(p),
        );
        match result {
            Ok(meta) => break meta,
            Err(e) => match auth_required(&e) {
                Some(auth)
                    if tries < 3
                        && login::interactive()
                        && !CANCEL.load(std::sync::atomic::Ordering::SeqCst) =>
                {
                    reporter.finish();
                    login = Some(login::ask(auth)?);
                    tries += 1;
                }
                _ => return Err(e),
            },
        }
    };
    reporter.finish();
    let run = &meta.last_run;
    if run["cancelled"] == true {
        eprintln!("stopped early; run the same command again to continue from the checkpoint");
    }
    eprintln!(
        "{}: {} steps on {} ({} new{}) in {:.1}s -> {}",
        meta.name,
        meta.steps,
        meta.branch,
        run["steps_new"],
        run["full_reason"]
            .as_str()
            .map(|r| format!(", full re-extract: {r}"))
            .unwrap_or_default(),
        run["elapsed_secs"].as_f64().unwrap_or(0.0),
        layout.repo_dir(&meta.id).display()
    );
    if run["inconsistent_files"].as_u64().unwrap_or(0) > 0 {
        eprintln!(
            "warning: {} file diffs disagreed with tracked state and were rebuilt",
            run["inconsistent_files"]
        );
    }
    Ok(())
}

fn cmd_list(layout: &Layout) -> anyhow::Result<()> {
    let repos = layout.list();
    if repos.is_empty() {
        println!("no repos cached in {}", layout.root.display());
    }
    for m in repos {
        let src = match &m.source {
            Source::Path { path } => path.display().to_string(),
            Source::Url { url } => url.clone(),
        };
        println!(
            "{:<32} {:>9} steps  {:<12} {}",
            m.id, m.steps, m.branch, src
        );
    }
    Ok(())
}

fn cmd_gc(layout: &Layout, days: u64, dry_run: bool) -> anyhow::Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs() as i64;
    let cutoff = now - (days as i64) * 86_400;
    for m in layout.list() {
        if m.updated_at >= cutoff {
            continue;
        }
        if dry_run {
            println!("would remove {}", layout.repo_dir(&m.id).display());
            if let Source::Url { url } = &m.source {
                println!(
                    "would remove {} unless shared",
                    layout.clone_dir(url).display()
                );
            }
            continue;
        }
        for d in strata_store::pipeline::remove_repo(layout, &m.id)? {
            println!("removed {}", d.display());
        }
    }
    // Leftovers no repo lists: interrupted first extractions and clones nothing reads.
    let cutoff =
        std::time::SystemTime::now() - std::time::Duration::from_secs(days.saturating_mul(86_400));
    for d in strata_store::pipeline::remove_orphans(layout, cutoff, dry_run)? {
        let verb = if dry_run { "would remove" } else { "removed" };
        println!("{verb} {} (no cached repo uses it)", d.display());
    }
    Ok(())
}

/// How a server started by `serve` is meant to stop (any of them also stops on Ctrl-C, SIGTERM
/// and a closed terminal).
enum Stop {
    CtrlC,
    /// Started by the app launcher in a terminal window: closing it stops strata.
    Window,
    /// Once no page has called the API for this long and no extraction is running.
    Idle(Duration),
}

/// The launcher's entry: reuse a strata server on `port`, else serve until `stop`.
fn cmd_app(layout: Layout, extract: &ExtractArgs, port: u16, stop: Stop) -> anyhow::Result<()> {
    if let Some(url) = running_server(port) {
        // This window closes at once; the one running that server is the one to close.
        eprintln!("strata is already running at {url}");
        return Ok(open::that_detached(&url)?);
    }
    let s = ServeArgs {
        port,
        host: "127.0.0.1".into(),
        no_open: false,
    };
    serve(layout, None, extract, &s, stop)
}

/// The address of a strata server answering on `port` on this machine, if there is one.
fn running_server(port: u16) -> Option<String> {
    use std::io::{Read, Write};
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut conn = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).ok()?;
    conn.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    conn.write_all(b"GET /api/ping HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        .ok()?;
    let mut reply = String::new();
    conn.take(64 << 10).read_to_string(&mut reply).ok()?;
    reply
        .contains(r#""app":"strata""#)
        .then(|| format!("http://127.0.0.1:{port}/"))
}

/// Serve the dashboard until `stop`.
fn serve(
    layout: Layout,
    source: Option<&str>,
    extract: &ExtractArgs,
    s: &ServeArgs,
    stop: Stop,
) -> anyhow::Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async {
        let cfg = ServerConfig {
            layout: layout.clone(),
            port: s.port,
            host: s.host.clone(),
            extract_opts: extract.options(),
        };
        let state = strata_server::app_state(&cfg)?;
        let (addr, server) = strata_server::bind(&cfg, state.clone()).await?;
        let mut url = format!("http://{addr}/");
        if let Some(src) = source {
            let source = Source::parse(src)?;
            let id = source.id();
            url = format!("http://{addr}/#/r/{id}");
            let json = extract.progress == ProgressMode::Json;
            let quiet = extract.progress == ProgressMode::None;
            let job = state.jobs.start(
                layout.clone(),
                source,
                extract.options(),
                !extract.no_fetch,
                None,
                |_| {},
            );
            // Mirror job progress in the terminal.
            let mut rx = job.tx.subscribe();
            tokio::spawn(async move {
                let mut reporter = progress::Reporter::new(json, quiet);
                while let Ok(status) = rx.recv().await {
                    reporter.update(&status.progress);
                    match status.state {
                        JobState::Running => {}
                        JobState::Done { .. } => {
                            reporter.finish();
                            eprintln!("extraction done");
                            break;
                        }
                        JobState::Failed { error } => {
                            reporter.finish();
                            eprintln!("extraction failed: {error}");
                            break;
                        }
                        JobState::Cancelled => break,
                        JobState::NeedsLogin { host, .. } => {
                            reporter.finish();
                            eprintln!("{host} wants a login: enter it in the browser");
                            break;
                        }
                    }
                }
            });
        }
        match stop {
            Stop::CtrlC => eprintln!("strata serving on {url}  (Ctrl-C to stop)"),
            Stop::Window => {
                if std::io::stderr().is_terminal() {
                    eprint!("\x1b]0;strata\x07"); // the window's title
                }
                eprintln!(
                    "strata is running at {url}\n\nClose this window or press Ctrl-C to stop it."
                );
            }
            Stop::Idle(d) => {
                strata_server::exit_when_idle(state.clone(), d);
                eprintln!(
                    "strata serving on {url}  (stops {} min after the last dashboard closes)",
                    d.as_secs().div_ceil(60)
                );
            }
        }
        if !s.no_open {
            let u = url.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                if let Err(e) = open::that_detached(&u) {
                    eprintln!("could not open a browser ({e}); visit {u}");
                }
            });
        }
        server.await?;
        // Give extractions the shutdown stopped time to checkpoint and kill their git. Nothing
        // prints from here: after a closed terminal, writing to stderr fails.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while state.jobs.any_running() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        anyhow::Ok(())
    })
}
