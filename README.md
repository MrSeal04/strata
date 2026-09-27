# strata

See how a git repository grew. `strata` reads a repo's history, measures every commit's
additions and deletions, tracks which commit (and author) wrote every surviving line, and plays
the history back in a browser dashboard with four linked views:

- **Evolving treemap**: every file sized by lines, laid out stably so files grow in place.
  Color by language, recent activity, line age or top author, and click to zoom into a folder.
- **File tree**: a radial tidy tree (default), force-directed (Gource-style), sunburst or
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
under `clones/`.

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
  are credited to the side-branch commits that wrote them. When that side branch's edits form a
  simple chain, strata replays them in process; otherwise it runs `git blame` limited to the
  side branch. On git/git this agrees with `git blame -w HEAD` for 99.1% of lines.
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
| myrepo | 422 | 2.1 s (debug build) | n/a | small | n/a |
| git/git | 24,344 | 25.6 s | ~770 MB | 10.8 MB | 47 ms (message search) |

## Development

```sh
make check      # cargo fmt/clippy/test (incl. git oracle tests) + tsc + vitest
make dev        # API on :7420, Vite with hot reload on :5173
make fixtures   # rebuild the deterministic test repos in fixtures/out
node tools/shot.mjs URL out.png [w] [h] [waitMs] [--dark] [--selector CSS] [--eval JS]
```

Dev builds link the prebuilt `libduckdb` (`DUCKDB_DOWNLOAD_LIB=1` in `.cargo/config.toml`).
`make bundled` compiles DuckDB into the binary instead.
