//! `strata render`: record playback to MP4/WebM/GIF with a headless browser feeding ffmpeg.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use clap::Args;
use serde_json::json;
use strata_engine::ExtractOptions;
use strata_server::ServerConfig;
use strata_server::render::{RenderJob, RenderState};
use strata_store::pipeline::extract_source;
use strata_store::{Layout, Source};

#[derive(Args)]
pub struct RenderArgs {
    /// Repo id (see `strata list`), directory or git URL (extracted first if needed)
    pub repo: String,
    /// Output file: .mp4, .webm or .gif
    #[arg(short, long)]
    pub output: PathBuf,
    /// dashboard, treemap, tree, area or bars
    #[arg(long, default_value = "dashboard")]
    pub view: String,
    /// Video length in seconds (history is spread evenly over it)
    #[arg(long, default_value_t = 30.0)]
    pub duration: f64,
    #[arg(long, default_value_t = 30)]
    pub fps: u32,
    /// Output pixels per layout pixel
    #[arg(long, default_value_t = 1.0)]
    pub scale: f64,
    /// Browser window (the dashboard's layout size), WIDTHxHEIGHT
    #[arg(long, default_value = "1600x900")]
    pub size: String,
    /// First / last step (commit index, 0-based) to include
    #[arg(long)]
    pub from: Option<u32>,
    #[arg(long)]
    pub to: Option<u32>,
    /// Seconds to hold the last frame
    #[arg(long, default_value_t = 2.0)]
    pub hold: f64,
    #[arg(long, default_value = "light")]
    pub theme: String,
    /// lang, heat, age or author
    #[arg(long)]
    pub color_by: Option<String>,
    /// radial, force, sunburst or icicle
    #[arg(long)]
    pub tree_layout: Option<String>,
    /// dir, lang, author or cohort
    #[arg(long)]
    pub area_slice: Option<String>,
    /// Show Gource-style author actors in the tree
    #[arg(long)]
    pub actors: bool,
    /// Browser binary (default: google-chrome, chromium or firefox from PATH, or $STRATA_BROWSER)
    #[arg(long)]
    pub browser: Option<String>,
}

fn which(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")?
        .to_str()?
        .split(':')
        .map(|d| Path::new(d).join(name))
        .find(|p| p.is_file())
}

fn browser(explicit: Option<&str>) -> anyhow::Result<PathBuf> {
    if let Some(b) = explicit
        .map(str::to_string)
        .or_else(|| std::env::var("STRATA_BROWSER").ok())
    {
        return Ok(PathBuf::from(b));
    }
    for name in [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "firefox",
    ] {
        if let Some(p) = which(name) {
            return Ok(p);
        }
    }
    bail!("no browser found (install Chrome/Chromium/Firefox or pass --browser)")
}

fn ffmpeg_args(output: &Path, fps: u32) -> anyhow::Result<Vec<String>> {
    let ext = output
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut a: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "image2pipe",
        "-framerate",
    ]
    .map(String::from)
    .to_vec();
    a.push(fps.to_string());
    a.extend(["-c:v", "png", "-i", "-"].map(String::from));
    match ext.as_str() {
        "mp4" | "mov" | "mkv" => a.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
            ]
            .map(String::from),
        ),
        "webm" => a.extend(
            [
                "-c:v",
                "libvpx-vp9",
                "-b:v",
                "0",
                "-crf",
                "32",
                "-pix_fmt",
                "yuv420p",
            ]
            .map(String::from),
        ),
        "gif" => a.extend(
            [
                "-vf",
                "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a",
            ]
            .map(String::from),
        ),
        other => bail!("unsupported output extension .{other} (use .mp4, .webm or .gif)"),
    }
    a.push(output.display().to_string());
    Ok(a)
}

pub fn run(layout: Layout, args: RenderArgs) -> anyhow::Result<()> {
    // Resolve (and if needed extract) the repo.
    let id = match layout.read_meta(&args.repo) {
        Ok(m) => m.id,
        Err(_) => {
            let source = Source::parse(&args.repo)?;
            if layout.read_meta(&source.id()).is_err() {
                eprintln!("extracting {} first…", source.name());
                let mut rep = crate::progress::Reporter::new(false, false);
                extract_source(
                    &layout,
                    &source,
                    &ExtractOptions::default(),
                    true,
                    None,
                    &AtomicBool::new(false),
                    &mut |p| rep.update(p),
                )?;
                rep.finish();
            }
            source.id()
        }
    };
    let (w, h) = args
        .size
        .split_once('x')
        .and_then(|(w, h)| Some((w.parse::<u32>().ok()?, h.parse::<u32>().ok()?)))
        .context("--size must be WIDTHxHEIGHT")?;
    let output = std::path::absolute(&args.output)?;
    let browser = browser(args.browser.as_deref())?;
    let ffmpeg = which("ffmpeg").context("ffmpeg not found in PATH")?;

    let mut settings = serde_json::Map::new();
    settings.insert("theme".into(), json!(args.theme));
    if let Some(v) = &args.color_by {
        settings.insert("colorBy".into(), json!(v));
    }
    if let Some(v) = &args.tree_layout {
        settings.insert("treeLayout".into(), json!(v));
    }
    if let Some(v) = &args.area_slice {
        settings.insert("areaSlice".into(), json!(v));
    }
    if args.actors {
        settings.insert("actors".into(), json!(true));
    }
    let spec = json!({
        "spec": { "target": args.view, "duration": args.duration, "fps": args.fps, "scale": args.scale,
                  "from": args.from, "to": args.to, "hold": args.hold },
        "settings": settings,
    });
    let token: String = format!("{:016x}", rand_u64());

    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        let cfg = ServerConfig {
            layout: layout.clone(),
            port: 0,
            host: "127.0.0.1".into(),
            extract_opts: ExtractOptions::default(),
        };
        let state = strata_server::app_state(&cfg)?;
        let (addr, server) = strata_server::bind(&cfg, state.clone()).await?;
        tokio::spawn(server);
        let child = Command::new(&ffmpeg)
            .args(ffmpeg_args(&output, args.fps)?)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .context("starting ffmpeg")?;
        let job = state.renders.add(&token, RenderJob::new(spec, child));

        let url = format!("http://{addr}/?render={token}#/r/{id}");
        let profile = std::env::temp_dir().join(format!("strata-render-{token}"));
        std::fs::create_dir_all(&profile)?;
        let is_firefox = browser
            .file_name()
            .is_some_and(|n| n.to_string_lossy().contains("firefox"));
        let mut cmd = Command::new(&browser);
        if is_firefox {
            cmd.args(["--headless", "--no-remote", "--profile"])
                .arg(&profile)
                .arg(format!("--window-size={w},{h}"))
                .arg(&url);
        } else {
            cmd.args([
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--hide-scrollbars",
                "--mute-audio",
                "--remote-debugging-port=0",
            ])
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg(format!("--window-size={w},{h}"))
            .arg(&url);
        }
        let mut browser_proc = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("starting {}", browser.display()))?;

        let started = Instant::now();
        let timeout = Duration::from_secs_f64(300.0 + args.duration * 40.0);
        let result = loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let (f, t) = (
                job.frames.load(Ordering::Relaxed),
                job.total.load(Ordering::Relaxed),
            );
            if t > 0 {
                eprint!("\rrendering frame {f}/{t}");
            }
            match job.state.lock().unwrap().clone() {
                RenderState::Done => break Ok(()),
                RenderState::Failed(e) => break Err(anyhow::anyhow!(e)),
                RenderState::Running => {}
            }
            if let Ok(Some(status)) = browser_proc.try_wait() {
                break Err(anyhow::anyhow!("browser exited early ({status})"));
            }
            if started.elapsed() > timeout {
                break Err(anyhow::anyhow!("timed out after {:?}", started.elapsed()));
            }
        };
        eprintln!();
        let _ = browser_proc.kill();
        let _ = browser_proc.wait();
        let _ = std::fs::remove_dir_all(&profile);
        result?;
        eprintln!(
            "wrote {} ({} frames in {:.1}s)",
            output.display(),
            job.frames.load(Ordering::Relaxed),
            started.elapsed().as_secs_f64()
        );
        anyhow::Ok(())
    })
}

fn rand_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    h.finish()
}
