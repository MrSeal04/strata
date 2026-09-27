# strata

See how a git repository grew. `strata` reads a repo's history, measures every commit's
additions and deletions, tracks which commit (and author) wrote every surviving line, and plays
the history back in a browser dashboard with four linked views:

- **Evolving treemap**: every file sized by lines, laid out stably so files grow in place.
  Color by language, recent activity, line age or top author, and click to zoom into a folder.
- **File tree**: force-directed (Gource-style, the default), a radial tidy tree, sunburst or
  icicle. Big folders collapse to fit, and author "actors" fly to the files they touch.
- **Stacked area**: repository size by directory, language, author (surviving lines) or
  *when lines were written* (survival cohorts), or added/deleted lines per period.
- **Per-commit bars**: additions up, deletions down, with a linear/sqrt/log scale and outlier
  clipping.

One timeline drives all four views. You can play it back (fixed length, commits per second, or
days per second), scrub, brush a range, search, filter by category, language or author, compare
two points, and export PNG, SVG, MP4 or GIF.

![](docs/dashboard.png)

## Quick start

```sh
make                      # builds the web app and target/release/strata
make install              # -> ~/.local/bin/strata (+ ~/.local/lib/strata/libduckdb.so)

strata ~/Projects/myrepo                       # extract, serve, open the browser
strata https://github.com/git/git              # clones into the cache first
strata ssh://git@git.example.com:2222/you/project.git
```

Re-running is incremental: only commits since the last run are processed.

Or skip the build: each [release](https://github.com/MrSeal04/strata/releases) ships a
self-contained Linux x86-64 binary with DuckDB compiled in (no `libduckdb.so` needed), and the
same binary as a `.deb`. The `.deb` is also published to an apt repository on the Forgejo server,
so `apt upgrade` picks up new releases; the release notes have the one-time setup.

## CLI

| Command | What it does |
|---|---|
| `strata [SOURCE]` | Extract `SOURCE` (path or git URL) if needed, serve, and open the dashboard. Without a source it opens the repo picker. |
| `strata extract SOURCE` | Extract only. `--full` starts over, `--branch B` picks a branch, `--threads N` sets the diff workers, `--merge-attribution blame\|merger` chooses who gets credit for merged lines, `--survival-ws ignore\|strict` sets whitespace handling, `--progress bar\|json\|none` sets the progress format. |
| `strata serve` | Serve every cached repo (`--port`, `--host`, `--no-open`). |
| `strata render REPO -o out.mp4` | Record playback headlessly (Chrome, Chromium or Firefox, plus ffmpeg). Options: `--view`, `--duration`, `--fps`, `--scale`, `--size 1600x900`, `--from/--to`, `--theme`, `--color-by`, `--tree-layout`, `--area-slice`, `--actors`. Writes `.mp4`, `.webm` or `.gif`. |
| `strata list` / `strata gc --older-than 90` | List cached repos, or delete stale ones and their clones. |
| `strata bench SOURCE` | Time the extraction and every query endpoint. Reports peak memory, cache size, and merge-blame work. `--verify N` checks survival attribution against `git blame -w` on N sampled files. |

The cache lives in `~/.cache/strata` (or `$STRATA_HOME`). URL sources are mirrored as bare clones
under `clones/`. A private HTTP(S) repository asks for a login: the dashboard shows a form, and
`strata extract` prompts in the terminal. strata keeps the login in memory until it exits and hands
it to git through a one-off credential helper, so it never reaches the URL, the command line or the
cache. SSH URLs use your keys and ssh-agent as usual. Ctrl-C (or SIGTERM) during an extraction
checkpoints and stops, and the next run continues from there.
Other environment knobs: `STRATA_BLAME_JOBS` caps concurrent `git blame` fallbacks (default: half
the CPUs), `STRATA_DUCKDB_MEMORY` caps the server's DuckDB (default 3GB), and `STRATA_LOG=debug`
turns on verbose logs.

## How it works

- **Timeline**: the first-parent chain of the branch. Each merge is one step, so totals never
  double-count. Commits a merge brings in are recorded as its *side commits*, which feed the
  hover cards, search and tag placement.
- **Diffs**: gitoxide tree diffs with rename tracking, and histogram line diffs for every
  changed blob. Each change is counted twice, strict and whitespace-insensitive, so "ignore
  whitespace" is a query-time toggle. Per-step counts match
  `git log --first-parent --numstat --diff-algorithm=histogram` exactly.
- **Survival**: every live file keeps a run-length list recording which commit wrote each line.
  Diffs splice it, so survival is exact at O(changed lines) per step. Lines a merge brings in
  are credited to the side-branch commits that wrote them. strata replays the side branch's
  edits in process, including merges inside it, memoizing line origins per file version. It runs
  `git blame` limited to the side branch only when a version can't be reached. On git/git this
  agrees with `git blame -w HEAD` for 99.1% of lines.
- **Storage**: Parquet parts per repo, plus a resumable checkpoint. The server loads each repo
  into DuckDB and answers binned, filtered queries as Arrow IPC.
- **Web app**: vanilla TypeScript, D3 and Canvas, drawing through a painter interface that also
  emits SVG. Colors follow a colorblind-validated palette. Additions and deletions are blue and
  red by default; classic green/red is available in the settings.

See [PLAN.md](PLAN.md) for the full design.

## Per-repo configuration

Put `.strata.toml` in the repo (or `strata.toml` in its cache directory):

```toml
branch = "main"

[identities]
merge = [["jane@old.example", "Jane Doe"]]   # names or emails that are one person
no_merge = ["build@ci.example"]
bots = ["deploy@ci.example"]
humans = ["renovate-human@example.com"]

[classify]                                   # glob -> category
"docs/generated/**" = "generated"
"testdata/**" = "data"
```

Categories are `source`, `docs`, `data`, `notebook`, `lockfile`, `vendored`, `generated`,
`binary` and `submodule`. Lockfiles, vendored, generated and binary files are hidden by default,
and each one is a toggle in the filter row.

## Benchmarks (desktop, 12 threads)

| Repo | First-parent commits | Extract | Peak memory (anon) | Cache | Slowest query p95 |
|---|---|---|---|---|---|
| strata (this repo) | 34 | 0.18 s | 57 MB (RSS) | <0.1 MB | 35 ms (area by directory) |
| git/git | 24,344 | 25.6 s | ~770 MB | 10.8 MB | 47 ms (message search) |
| torvalds/linux | 77,194 | ~36 min (+ ~30 min clone) | 1.0–1.6 GB | 227 MB | see below |

Linux notes:
- The extraction was interrupted at step 60,771 and resumed on a newer engine. The first 60,771
  steps took ~25 minutes; the last 16,423 took 10.6 minutes with parallel blame fallbacks.
- Merge attribution agreed with `git blame -w HEAD` for 90.1% of lines on 20 sampled files.
- Dashboard playback runs at ~17 fps in Chrome on the desktop GPU (WebGL treemap layer, ~60k
  cells), measured while other jobs held the machine at load average 15.

## Development

```sh
make check      # cargo fmt/clippy/test (incl. git oracle tests) + tsc + vitest
make dev        # API on :7420, Vite with hot reload on :5173
make fixtures   # rebuild the deterministic test repos in fixtures/out
node tools/shot.mjs URL out.png [w] [h] [waitMs] [--dark] [--selector CSS] [--eval JS]
```

Dev builds link the prebuilt `libduckdb` (`DUCKDB_DOWNLOAD_LIB=1` in `.cargo/config.toml`).
`make bundled` compiles DuckDB into the binary instead, producing `target/strata-bundled`: one
self-contained 69 MB executable (DuckDB's debug info is stripped; unstripped it is over 1 GB),
with no `libduckdb.so` needed at runtime. It took 27 minutes on the desktop with 3 compile jobs; each
DuckDB compiler process uses 1–1.5 GB, so keep `CARGO_BUILD_JOBS` low on a busy machine.
`make deb` packages it as `target/strata_<version>_amd64.deb` (`tools/make-deb.sh`), with the
library dependencies derived by `dpkg-shlibdeps`.
