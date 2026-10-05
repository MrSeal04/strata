//! Deleting a cached repo removes only what strata created: its cache directory, and a remote's
//! clone unless another cached repo shares it. It never touches a local repository, refuses while
//! an extraction holds the lock, and accepts only real cache ids. `strata gc` also removes what no
//! cached repo lists: interrupted first extractions and clones nothing reads.

use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;

use std::time::{Duration, SystemTime};
use strata_engine::ExtractOptions;

use strata_store::pipeline::{Busy, extract_source, remove_orphans, remove_repo};
use strata_store::{Layout, RepoMeta, Source};

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "A")
        .env("GIT_AUTHOR_EMAIL", "a@example.com")
        .env("GIT_COMMITTER_NAME", "A")
        .env("GIT_COMMITTER_EMAIL", "a@example.com")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {out:?}");
}

/// A work tree with two commits.
fn work_tree(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    for n in 1..=2 {
        std::fs::write(dir.join("a.txt"), "line\n".repeat(n)).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", &format!("c{n}")]);
    }
}

fn extract(layout: &Layout, src: &str) -> RepoMeta {
    extract_source(
        layout,
        &Source::parse(src).unwrap(),
        &ExtractOptions::default(),
        true,
        None,
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .unwrap()
}

#[test]
fn local_repository_is_never_touched() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    work_tree(&src);
    let layout = Layout::new(tmp.path().join("home"));
    let meta = extract(&layout, src.to_str().unwrap());
    assert!(layout.repo_dir(&meta.id).join("meta.json").exists());

    let removed = remove_repo(&layout, &meta.id).unwrap();
    assert_eq!(removed, vec![layout.repo_dir(&meta.id)]);
    assert!(!layout.repo_dir(&meta.id).exists());
    assert!(layout.list().is_empty());
    assert!(src.join(".git/HEAD").exists());
    assert_eq!(
        std::fs::read_to_string(src.join("a.txt")).unwrap(),
        "line\nline\n"
    );
}

#[test]
fn clone_goes_with_its_last_repo() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    work_tree(&src);
    let layout = Layout::new(tmp.path().join("home"));
    let url = format!("file://{}", src.display());
    let meta = extract(&layout, &url);
    let clone = layout.clone_dir(&url);
    assert!(clone.starts_with(layout.root.join("clones")));
    assert!(clone.join("HEAD").exists());

    // Another cached URL that reads the same clone (`clone_dir` ignores the scheme).
    let twin_url = url.replacen("file://", "https://", 1);
    assert_eq!(layout.clone_dir(&twin_url), clone);
    let twin_src = Source::Url { url: twin_url };
    let twin = RepoMeta {
        id: twin_src.id(),
        source: twin_src,
        ..meta.clone()
    };
    layout.write_meta(&twin).unwrap();

    assert_eq!(
        remove_repo(&layout, &meta.id).unwrap(),
        vec![layout.repo_dir(&meta.id)]
    );
    assert!(
        clone.join("HEAD").exists(),
        "the twin still reads the clone"
    );
    assert_eq!(
        remove_repo(&layout, &twin.id).unwrap(),
        vec![layout.repo_dir(&twin.id), clone.clone()]
    );
    assert!(!clone.exists());
    let clones = layout.root.join("clones");
    assert_eq!(
        std::fs::read_dir(&clones).unwrap().count(),
        0,
        "empty parents go too"
    );
    assert!(src.join(".git/HEAD").exists());
}

#[test]
fn refuses_while_an_extraction_holds_the_lock() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    work_tree(&src);
    let layout = Layout::new(tmp.path().join("home"));
    let meta = extract(&layout, src.to_str().unwrap());

    let lock = std::fs::File::create(layout.repo_dir(&meta.id).join("extract.lock")).unwrap();
    lock.try_lock().unwrap();
    let err = remove_repo(&layout, &meta.id).unwrap_err();
    assert!(err.is::<Busy>(), "{err:#}");
    assert!(layout.repo_dir(&meta.id).join("meta.json").exists());
    drop(lock);
    remove_repo(&layout, &meta.id).unwrap();
}

#[test]
fn only_real_cache_ids_are_accepted() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    work_tree(&src);
    let layout = Layout::new(tmp.path().join("home"));
    let meta = extract(&layout, src.to_str().unwrap());
    // A valid meta.json where `repos/..` would find one, so only the id check stops it.
    let decoy = RepoMeta {
        id: "..".into(),
        ..meta.clone()
    };
    std::fs::write(
        tmp.path().join("home/meta.json"),
        serde_json::to_vec(&decoy).unwrap(),
    )
    .unwrap();
    assert_eq!(layout.read_meta("..").unwrap().id, "..");

    for id in [
        "",
        ".",
        "..",
        "../home",
        "repos/..",
        "a/b",
        "src-00000000",
        " ",
    ] {
        let err = remove_repo(&layout, id).unwrap_err();
        assert!(err.to_string().contains("not found"), "{id:?}: {err:#}");
    }
    assert!(layout.repo_dir(&meta.id).join("meta.json").exists());
    assert!(tmp.path().join("home/meta.json").exists());
    assert!(src.join(".git/HEAD").exists());
}

/// Set the modification time of `path` and everything below it to `secs` ago.
fn age(path: &Path, secs: u64) {
    let when = SystemTime::now() - Duration::from_secs(secs);
    if path.is_dir() {
        for e in std::fs::read_dir(path).unwrap().flatten() {
            age(&e.path(), secs);
        }
    }
    std::fs::File::open(path)
        .unwrap()
        .set_modified(when)
        .unwrap();
}

#[test]
fn gc_removes_interrupted_extractions_and_unused_clones() {
    const DAY: u64 = 86_400;
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    work_tree(&src);
    let layout = Layout::new(tmp.path().join("home"));
    // A cached remote, listed, with its clone.
    let url = format!("file://{}", src.display());
    let meta = extract(&layout, &url);
    let used_clone = layout.clone_dir(&url);
    // An interrupted first extraction (no meta.json), a clone nothing reads and a clone that
    // never finished, all untouched for two days.
    let orphan = layout.repo_dir("other-0123abcd");
    std::fs::create_dir_all(&orphan).unwrap();
    std::fs::write(orphan.join("checkpoint.bin"), b"x").unwrap();
    let unused_clone = layout.root.join("clones/git.example.com/you/other.git");
    std::fs::create_dir_all(&unused_clone).unwrap();
    std::fs::write(unused_clone.join("HEAD"), b"ref: refs/heads/main\n").unwrap();
    let partial = layout.root.join("clones/git.example.com/you/third.partial");
    std::fs::create_dir_all(&partial).unwrap();
    let mut all = vec![orphan.clone(), unused_clone.clone(), partial.clone()];
    all.sort();
    for p in &all {
        age(p, 2 * DAY);
    }
    let sorted = |mut v: Vec<std::path::PathBuf>| {
        v.sort();
        v
    };
    let a_day_ago = SystemTime::now() - Duration::from_secs(DAY);
    let three_days_ago = SystemTime::now() - Duration::from_secs(3 * DAY);

    assert!(
        remove_orphans(&layout, three_days_ago, false)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        sorted(remove_orphans(&layout, a_day_ago, true).unwrap()),
        all
    );
    assert!(all.iter().all(|p| p.exists()), "a dry run removes nothing");
    // (and it touched nothing: they're still old)
    assert_eq!(
        sorted(remove_orphans(&layout, a_day_ago, true).unwrap()),
        all
    );

    // A first extraction still running keeps its directory, and every clone (it may be cloning).
    let lock = std::fs::File::create(orphan.join("extract.lock")).unwrap();
    lock.try_lock().unwrap();
    age(&orphan, 2 * DAY);
    assert!(
        remove_orphans(&layout, a_day_ago, false)
            .unwrap()
            .is_empty()
    );
    assert!(all.iter().all(|p| p.exists()));
    drop(lock);

    assert_eq!(
        sorted(remove_orphans(&layout, a_day_ago, false).unwrap()),
        all
    );
    assert!(all.iter().all(|p| !p.exists()));
    assert!(
        !layout.root.join("clones/git.example.com").exists(),
        "empty parents go too"
    );
    assert!(layout.repo_dir(&meta.id).join("meta.json").exists());
    assert!(used_clone.join("HEAD").exists());
    assert!(src.join(".git/HEAD").exists());
}
