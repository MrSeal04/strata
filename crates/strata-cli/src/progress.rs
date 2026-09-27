//! Terminal progress: a redrawn status line, or JSON lines for machines (e.g. the status panel).

use std::io::{IsTerminal, Write};
use std::time::{Duration, Instant};

use strata_store::pipeline::JobProgress;

pub struct Reporter {
    json: bool,
    quiet: bool,
    /// stderr is a terminal: redraw one status line; otherwise print a line every few seconds.
    tty: bool,
    last: Option<Instant>,
    drew: bool,
}

pub fn human_secs(s: f64) -> String {
    let s = s.max(0.0) as u64;
    match s {
        0..60 => format!("{s}s"),
        60..3600 => format!("{}m{:02}s", s / 60, s % 60),
        _ => format!("{}h{:02}m", s / 3600, (s % 3600) / 60),
    }
}

impl Reporter {
    pub fn new(json: bool, quiet: bool) -> Self {
        Self {
            json,
            quiet,
            tty: std::io::stderr().is_terminal(),
            last: None,
            drew: false,
        }
    }

    pub fn update(&mut self, p: &JobProgress) {
        if self.quiet {
            return;
        }
        let done = p.total > 0 && p.done >= p.total;
        let throttle = if self.json {
            Duration::from_secs(5)
        } else {
            Duration::from_millis(200)
        };
        if !done && self.last.is_some_and(|t| t.elapsed() < throttle) {
            return;
        }
        self.last = Some(Instant::now());
        let mut err = std::io::stderr().lock();
        if self.json {
            let _ = writeln!(err, "{}", serde_json::to_string(p).unwrap_or_default());
            return;
        }
        let line = match (p.phase.as_str(), &p.message) {
            ("clone", Some(m)) => format!("clone  {m}"),
            (phase, _) if p.total > 0 => {
                let pct = 100.0 * p.done as f64 / p.total as f64;
                let eta = p
                    .eta_secs
                    .map(|e| format!("  eta {}", human_secs(e)))
                    .unwrap_or_default();
                format!(
                    "{phase:<6} {}/{} ({pct:.1}%)  {:.0} steps/s{eta}",
                    p.done, p.total, p.steps_per_sec
                )
            }
            (phase, _) => format!("{phase}..."),
        };
        if self.tty {
            let _ = write!(err, "\r\x1b[2K{line}");
            self.drew = true;
        } else {
            let _ = writeln!(err, "{line}");
        }
        let _ = err.flush();
    }

    pub fn finish(&mut self) {
        if self.drew && !self.json {
            eprintln!();
        }
        self.drew = false;
    }
}
