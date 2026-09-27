//! `strata`: see how a git repository grew over time.

mod bench;
mod progress;
mod render;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use anyhow::Context;
use clap::{Args, Parser, Subcommand, ValueEnum};
use strata_engine::ExtractOptions;
use strata_engine::diff::DiffOptions;
use strata_server::ServerConfig;
use strata_server::jobs::JobState;
use strata_store::pipeline::extract_source;
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
        Some(Cmd::Serve(s)) => serve(layout, None, &cli.extract, &s),
        Some(Cmd::List) => cmd_list(&layout),
        Some(Cmd::Gc {
            older_than,
            dry_run,
        }) => cmd_gc(&layout, older_than, dry_run),
        Some(Cmd::Render(r)) => render::run(layout, r),
        Some(Cmd::Bench(b)) => bench::run(layout, b),
        None => serve(layout, cli.source.as_deref(), &cli.extract, &cli.serve),
    }
}

fn cmd_extract(layout: &Layout, source: &str, args: &ExtractArgs) -> anyhow::Result<()> {
    let source = Source::parse(source)?;
    let mut reporter = progress::Reporter::new(
        args.progress == ProgressMode::Json,
        args.progress == ProgressMode::None,
    );
    let meta = extract_source(
        layout,
        &source,
        &args.options(),
        !args.no_fetch,
        &AtomicBool::new(false),
        &mut |p| reporter.update(p),
    )?;
    reporter.finish();
    let run = &meta.last_run;
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
        let mut dirs = vec![layout.repo_dir(&m.id)];
        if let Source::Url { url } = &m.source {
            dirs.push(layout.clone_dir(url));
        }
        for d in dirs {
            println!(
                "{} {}",
                if dry_run { "would remove" } else { "removing" },
                d.display()
            );
            if !dry_run {
                std::fs::remove_dir_all(&d).with_context(|| format!("removing {}", d.display()))?;
            }
        }
    }
    Ok(())
}

fn serve(
    layout: Layout,
    source: Option<&str>,
    extract: &ExtractArgs,
    s: &ServeArgs,
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
                    }
                }
            });
        }
        eprintln!("strata serving on {url}  (Ctrl-C to stop)");
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
        anyhow::Ok(())
    })
}
