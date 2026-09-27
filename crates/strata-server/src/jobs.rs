//! Background extraction jobs with progress broadcast (consumed by SSE and the CLI).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use strata_engine::ExtractOptions;
use strata_store::pipeline::{JobProgress, extract_source};
use strata_store::{Layout, Source};
use tokio::sync::broadcast;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum JobState {
    Running,
    Done { repo: String },
    Failed { error: String },
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
pub struct JobStatus {
    pub id: String,
    pub repo: String,
    pub source: Source,
    #[serde(flatten)]
    pub state: JobState,
    pub progress: JobProgress,
}

pub struct Job {
    pub status: Mutex<JobStatus>,
    pub tx: broadcast::Sender<JobStatus>,
    pub cancel: AtomicBool,
}

#[derive(Default)]
pub struct Jobs {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    counter: AtomicU64,
}

impl Jobs {
    pub fn get(&self, id: &str) -> Option<Arc<Job>> {
        self.jobs.lock().unwrap().get(id).cloned()
    }

    pub fn running_for(&self, repo: &str) -> Option<Arc<Job>> {
        self.jobs
            .lock()
            .unwrap()
            .values()
            .find(|j| {
                let s = j.status.lock().unwrap();
                s.repo == repo && matches!(s.state, JobState::Running)
            })
            .cloned()
    }

    pub fn all(&self) -> Vec<JobStatus> {
        self.jobs
            .lock()
            .unwrap()
            .values()
            .map(|j| j.status.lock().unwrap().clone())
            .collect()
    }

    /// Start extracting `source` on a blocking thread (or return the job already running for it).
    pub fn start(
        self: &Arc<Self>,
        layout: Layout,
        source: Source,
        opts: ExtractOptions,
        fetch: bool,
        on_done: impl FnOnce(&JobStatus) + Send + 'static,
    ) -> Arc<Job> {
        let repo = source.id();
        if let Some(j) = self.running_for(&repo) {
            return j;
        }
        let id = format!("j{}", self.counter.fetch_add(1, Ordering::Relaxed) + 1);
        let (tx, _) = broadcast::channel(256);
        let job = Arc::new(Job {
            status: Mutex::new(JobStatus {
                id: id.clone(),
                repo: repo.clone(),
                source: source.clone(),
                state: JobState::Running,
                progress: JobProgress {
                    phase: "queued".into(),
                    ..Default::default()
                },
            }),
            tx,
            cancel: AtomicBool::new(false),
        });
        self.jobs.lock().unwrap().insert(id, job.clone());
        let j = job.clone();
        std::thread::spawn(move || {
            let publish = |job: &Job, f: &dyn Fn(&mut JobStatus)| {
                let mut s = job.status.lock().unwrap();
                f(&mut s);
                let _ = job.tx.send(s.clone());
            };
            let result = extract_source(&layout, &source, &opts, fetch, &j.cancel, &mut |p| {
                publish(&j, &|s| s.progress = p.clone());
            });
            let state = match result {
                Ok(meta) if j.cancel.load(Ordering::Relaxed) => {
                    let _ = meta;
                    JobState::Cancelled
                }
                Ok(meta) => JobState::Done { repo: meta.id },
                Err(_) if j.cancel.load(Ordering::Relaxed) => JobState::Cancelled,
                Err(e) => JobState::Failed {
                    error: format!("{e:#}"),
                },
            };
            publish(&j, &|s| s.state = state.clone());
            on_done(&j.status.lock().unwrap());
        });
        job
    }
}
