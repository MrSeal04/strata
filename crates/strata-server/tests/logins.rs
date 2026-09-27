//! Server jobs keep a working login in memory for later fetches and forget a refused one.

#[path = "../../strata-store/tests/support/auth_git.rs"]
mod auth_git;

use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use strata_engine::ExtractOptions;
use strata_server::jobs::{JobState, Jobs};
use strata_store::pipeline::Credentials;
use strata_store::{Layout, Source};

fn run(jobs: &Arc<Jobs>, layout: &Layout, url: &str, login: Option<Credentials>) -> JobState {
    let (tx, rx) = mpsc::channel();
    let source = Source::parse(url).unwrap();
    jobs.start(
        layout.clone(),
        source,
        ExtractOptions::default(),
        true,
        login,
        move |s| {
            let _ = tx.send(s.state.clone());
        },
    );
    rx.recv_timeout(Duration::from_secs(60))
        .expect("job finished")
}

#[test]
fn working_login_is_remembered_and_refused_one_forgotten() {
    let remote = auth_git::private_remote(2);
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().to_path_buf());
    let jobs = Arc::new(Jobs::default());
    let right = Credentials::new(auth_git::USER, auth_git::PASS).unwrap();
    let wrong = Credentials::new(auth_git::USER, "nope").unwrap();

    let s = run(&jobs, &layout, &remote.url, None);
    assert!(
        matches!(
            s,
            JobState::NeedsLogin {
                rejected: false,
                ..
            }
        ),
        "{s:?}"
    );
    let s = run(&jobs, &layout, &remote.url, Some(right));
    assert!(matches!(s, JobState::Done { .. }), "{s:?}");
    // The next run fetches with the remembered login.
    let s = run(&jobs, &layout, &remote.url, None);
    assert!(matches!(s, JobState::Done { .. }), "{s:?}");
    // A refused login is reported, and neither it nor the old one is kept.
    let s = run(&jobs, &layout, &remote.url, Some(wrong));
    assert!(
        matches!(s, JobState::NeedsLogin { rejected: true, .. }),
        "{s:?}"
    );
    let s = run(&jobs, &layout, &remote.url, None);
    assert!(
        matches!(
            s,
            JobState::NeedsLogin {
                rejected: false,
                ..
            }
        ),
        "{s:?}"
    );
}

#[test]
fn needs_login_state_is_serialized_for_the_dashboard() {
    let v = serde_json::to_value(JobState::NeedsLogin {
        host: "http://h:3000".into(),
        rejected: true,
    })
    .unwrap();
    assert_eq!(
        v,
        serde_json::json!({ "state": "credentials", "host": "http://h:3000", "rejected": true })
    );
}
