//! Private HTTP remotes: a login reaches git only through strata's in-memory credential helper,
//! never through argv, the URL or anything in the cache.

mod support;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use strata_engine::ExtractOptions;
use strata_store::pipeline::{Credentials, auth_required, extract_source};
use strata_store::{Layout, RepoMeta, Source};
use support::auth_git::{PASS, USER, argv_holding, private_remote};

fn extract(layout: &Layout, url: &str, login: Option<&Credentials>) -> anyhow::Result<RepoMeta> {
    let src = Source::parse(url).unwrap();
    extract_source(
        layout,
        &src,
        &ExtractOptions::default(),
        true,
        login,
        &AtomicBool::new(false),
        &mut |_| {},
    )
}

/// Every file under `dir` whose bytes contain `needle`.
fn files_holding(dir: &Path, needle: &str) -> Vec<String> {
    let mut hits = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            hits.extend(files_holding(&p, needle));
        } else if std::fs::read(&p)
            .is_ok_and(|b| b.windows(needle.len()).any(|w| w == needle.as_bytes()))
        {
            hits.push(p.display().to_string());
        }
    }
    hits
}

#[test]
fn login_reaches_git_only_through_the_helper() {
    let remote = private_remote(3);
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().to_path_buf());

    // No login: strata reports that one is needed instead of failing opaquely.
    let err = extract(&layout, &remote.url, None).unwrap_err();
    let auth = auth_required(&err).unwrap_or_else(|| panic!("not AuthRequired: {err:#}"));
    assert!(!auth.rejected);
    assert!(
        remote.url.starts_with(&auth.host),
        "{} vs {}",
        auth.host,
        remote.url
    );

    // A wrong login is reported as rejected.
    let wrong = Credentials::new(USER, "not-the-password").unwrap();
    let err = extract(&layout, &remote.url, Some(&wrong)).unwrap_err();
    assert!(auth_required(&err).is_some_and(|a| a.rejected), "{err:#}");

    // The right login clones. Meanwhile no process may carry the password in its argv; the
    // scan must also see the clone's own processes, or it proved nothing.
    let right = Credentials::new(USER, PASS).unwrap();
    let done = AtomicBool::new(false);
    let (meta, seen, leaked) = std::thread::scope(|s| {
        let scan = s.spawn(|| {
            let (mut seen, mut leaked) = (0, Vec::new());
            while !done.load(Ordering::Relaxed) {
                seen += argv_holding("private.git").len();
                leaked.extend(argv_holding(PASS));
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            (seen, leaked)
        });
        let meta = extract(&layout, &remote.url, Some(&right));
        done.store(true, Ordering::Relaxed);
        let (seen, leaked) = scan.join().unwrap();
        (meta, seen, leaked)
    });
    let meta = meta.unwrap_or_else(|e| panic!("clone with the right login: {e:#}"));
    assert_eq!(meta.steps as usize, remote.commits);
    assert!(seen > 0, "the argv scan never saw the git processes");
    assert!(leaked.is_empty(), "password in argv: {leaked:?}");

    // Nothing in the cache holds the password: not the clone's config, meta.json or the tables.
    assert_eq!(files_holding(home.path(), PASS), Vec::<String>::new());

    // Later runs fetch, which needs the login too.
    let meta = extract(&layout, &remote.url, Some(&right)).unwrap();
    assert_eq!(meta.steps as usize, remote.commits);
    let err = extract(&layout, &remote.url, None).unwrap_err();
    assert!(auth_required(&err).is_some_and(|a| !a.rejected), "{err:#}");
}
