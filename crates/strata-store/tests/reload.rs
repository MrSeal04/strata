//! Tables built on first use (area aggregates, `rename_edits`) are rebuilt after the repo's
//! tables reload: a later extraction replaces the schema they lived in.

use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;

use strata_engine::ExtractOptions;
use strata_store::pipeline::extract_source;
use strata_store::{AreaMode, AreaQuery, Axis, Bins, Db, Filters, Layout, Slice, Source};

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

fn commit(dir: &Path, lines: usize) {
    std::fs::write(dir.join("a.txt"), "line\n".repeat(lines)).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", &format!("{lines} lines")]);
}

fn extract(layout: &Layout, src: &Path) -> String {
    extract_source(
        layout,
        &Source::parse(src.to_str().unwrap()).unwrap(),
        &ExtractOptions::default(),
        false,
        None,
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .unwrap()
    .id
}

/// Lines at the last bin of a by-directory size area chart.
fn area_total(db: &Db, id: &str) -> f64 {
    let q = AreaQuery {
        slice: Slice::Dir,
        mode: AreaMode::Size,
        depth: 1,
        top: 12,
        unit: "year".into(),
    };
    let b = Bins {
        axis: Axis::Index,
        lo: 0.0,
        hi: 100.0,
        bins: 1,
    };
    let bytes = db.area(id, &Filters::default(), &b, &q).unwrap();
    let reader =
        arrow::ipc::reader::StreamReader::try_new(std::io::Cursor::new(&bytes[..]), None).unwrap();
    let mut total = 0.0;
    for batch in reader {
        let batch = batch.unwrap();
        let v = batch
            .column_by_name("value")
            .unwrap()
            .as_any()
            .downcast_ref::<arrow::array::Float64Array>()
            .unwrap()
            .clone();
        total += v.iter().flatten().sum::<f64>();
    }
    total
}

#[test]
fn lazily_built_tables_survive_a_reload() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    git(&src, &["init", "-q", "-b", "main"]);
    commit(&src, 3);
    let layout = Layout::new(tmp.path().join("home"));
    let id = extract(&layout, &src);
    let db = Db::new(layout.clone()).unwrap();
    assert_eq!(area_total(&db, &id), 3.0);
    db.state(&id, 0, &Filters::default()).unwrap();

    // New commits: the next query reloads the repo's schema, dropping what was built in it.
    commit(&src, 7);
    commit(&src, 10);
    extract(&layout, &src);
    assert_eq!(area_total(&db, &id), 10.0);
    db.state(&id, 2, &Filters::default()).unwrap();
}
