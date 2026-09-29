# strata — plan

`strata` is a local web app that shows how a git repository grew over time: every commit's
additions and deletions, played back through four linked views that share one timeline.
It has to handle repos from 50 commits up to Linux-kernel scale (1M+ commits).

```
strata ~/Projects/myrepo                        # extract (incrementally) + serve + open the browser
strata https://github.com/torvalds/linux       # clone into the cache, then the same
strata ssh://git@git.example.com:2222/you/project.git
```

---

## 1. Decisions (from the Q&A, 2026-09-27)

| Topic | Decision |
|---|---|
| Views | All four: **stacked area**, **per-commit +/- bars**, **animated file tree**, **evolving treemap** |
| Audience | Personal exploration, sharing/showing off, and serious codebase analysis. Accuracy *and* polish both matter |
| Repo sources | Local clones, public GitHub URLs, Forgejo repos (treated as plain git URLs, no Forgejo API) |
| Form | **Local web app**: one CLI binary extracts the data, serves the UI and opens the browser. Runs on whatever machine launched it |
| Time axis | Toggle between **calendar time** and **commit index** |
| Slice by | **Directory**, **language/file type**, **author** |
| Survival | **Yes**: cohort layers (lines by when they were written) and surviving lines by author |
| Branches | **First-parent walk of the main branch**. Each merge is one step |
| Default exclusions | **Lockfiles**, **vendored/generated**, **binary**. Each can be toggled back on. Data files and notebooks are *included* by default |
| Renames | **Detected and followed**. A file keeps its identity through moves |
| Outliers | All of these are **settings**: log/sqrt scale, clamp at a percentile and mark the clipped bars, ignore whitespace-only changes |
| Scale target | **Huge (1M+ commits)**, with the Linux kernel as the benchmark |
| Engine | **Rust** |
| Frontend | **Vanilla TypeScript + D3 + Canvas** (no UI framework) |
| Storage | **Parquet** per repo, queried with **DuckDB** on the server |
| Re-runs | **Incremental**: resume from a checkpoint and process only new commits |
| Layout | **Linked dashboard**: treemap and tree on top, stacked area, then bars, then the transport bar |
| Playback | All three **selectable**: fixed total duration, one commit per tick, calendar-proportional |
| Interactions | Hover details, drill into folders, brush a time range, compare two dates |
| Annotations | Git tags/releases, search highlight |
| Tree layout | All three **selectable**: force-directed, radial tidy tree, icicle/sunburst |
| Author actors | Gource-style actors in the tree view, **toggle** (off by default) |
| Treemap | **Stable, ordered** layout. Rectangles grow in place |
| Color by | Dropdown: **language** (default), recent-activity heat, line age, top author |
| Export | **PNG/SVG snapshot**, **MP4/GIF recording**. No static HTML bundle, no README image |
| Video | **Both**: in-browser WebCodecs for one-offs, headless browser + ffmpeg for batch |
| First milestone | **Vertical slice of all four views**, rough, then deepen |
| Identities | Respect `.mailmap`, auto-merge heuristics with per-repo overrides, flag bots |
| Name | **strata** |
| VCS | Git, committed incrementally and pushed to Forgejo (`strata`) |

### Calls I made myself (override any of them)

- **Merges and authorship.** With a first-parent walk, a merge step brings in a whole side branch.
  Crediting all of it to the person who merged would make Linus the author of the whole kernel.
  So the lines a merge adds are attributed to their real originating commits with a ranged blame.
  A `--merge-attribution=merger` fast mode skips that (§4.5).
- **Whitespace is a query-time toggle, not a re-extract.** The engine records two counts for every
  file change: a normal diff and a whitespace-insensitive one (§4.3).
- **Survival ignores whitespace by default.** A `ruff format` run doesn't make code "new". This is
  an extraction setting (`--survival-ws=ignore|strict`).
- **"Fixed total duration" playback is linear in commit index.** Each commit gets equal screen time
  and the whole run fits the chosen duration, so quiet periods fly by on their own.
- **The area chart has two modes.** *Size* shows cumulative lines, stacked. *Flow* shows each bin's
  additions stacked above the axis and its deletions below, which is where the red and green lives.
- **All views draw through a `Painter` interface** with Canvas2D and SVG-string backends. That's how
  canvas views export real SVG (§6.2).
- **The per-commit skip list was dropped** in favor of the outlier settings, per "make it a setting".
- **Submodules** show as a marker leaf with 0 lines and never count toward totals.
- **Axis time is the committer date of each first-parent step** (when it landed on main), made
  monotonic with a running max because committer dates aren't strictly ordered. Hover shows the
  author date. Survival cohorts use the author date of the originating commit.

---

## 2. Architecture

```
                         ┌──────────────────────── strata (one Rust binary) ────────────────────────┐
  local path ─┐          │                                                                          │
  git URL ────┼─ clone ─▶│  engine                        store                     server          │
              │ (mirror) │  ┌─────────────┐  hunks  ┌──────────────┐  parquet  ┌──────────────┐  │
              │          │  │ first-parent├────────▶│ line tracker ├──────────▶│ DuckDB query │  │
              │          │  │ walk + diff │ changes │ (RLE origins)│  parts    │ layer (axum) │──┼──▶ browser
              │          │  │ (parallel)  ├────────▶│ aggregates   │           │ Arrow / JSON │  │   (vanilla TS,
              │          │  └─────────────┘         └──────┬───────┘           └──────▲───────┘  │    D3, Canvas)
              │          │   merge steps ─▶ ranged blame   │ checkpoint.bin           │ SSE      │
              │          │                                  ▼                          │ progress │
              │          │                   ~/.cache/strata/<repo-id>/  ◀─────────────┘          │
              │          └──────────────────────────────────────────────────────────────────────────┘
```

### Repo layout

```
Cargo.toml                 workspace
crates/
  strata-engine/           git walk, diffs, classification, identities, line tracker, checkpoint
  strata-store/            Parquet schema + writers, part-file management, DuckDB query layer
  strata-server/           axum HTTP API, SSE job progress, embedded static assets, render orchestration
  strata-cli/              the `strata` binary: extract / serve / render / list / gc / bench
web/
  package.json, vite.config.ts, tsconfig.json
  src/
    main.ts
    state/                 observable app store (cursor, brush, root, filters, settings)
    api/                   typed client, Arrow decoding, chunk prefetch cache
    timeline/              playback clock, the 3 playback modes, axis mapping (index <-> calendar)
    paint/                 Painter interface, CanvasPainter, SvgPainter
    views/bars/  views/area/  views/tree/  views/treemap/
    ui/                    transport bar, settings panel, hover card, search box, breadcrumb, A/B picker
    export/                png, svg, webcodecs-mp4, gif, headless-render client
    workers/               force layout worker, layout/aggregation worker
fixtures/                  scripts that build small deterministic test repos (see §8)
PLAN.md
```

In release builds the web app is built by Vite and embedded into the binary (`rust-embed`), so
`strata` is a single file. In dev, the server proxies to the Vite dev server for hot reload.

### Key dependencies

- **Rust:** `gix` (gitoxide) for the rev walk, tree diff with rename tracking, blob access and
  mailmap; `imara-diff` (histogram algorithm) for blob diffs; `rayon`; `arrow` + `parquet`
  (arrow-rs) for writing; `duckdb` (bundled) for queries; `axum` + `tokio`; `clap`; `serde`;
  `rust-embed`. The system `git` binary is used for cloning/fetching (so SSH agents and credentials
  just work) and for `git blame --incremental` on merge steps.
- **Web:** `d3` (scale, shape, hierarchy, force, array, interpolate, brush), `apache-arrow`,
  `mp4-muxer`/`mediabunny` (WebCodecs to MP4), `gifenc`, Vite, Vitest. Nothing else.

---

## 3. CLI

```
strata [<path|url>]                     extract incrementally, then serve and open the browser
strata extract <path|url> [--full] [--branch main] [--threads N]
               [--merge-attribution blame|merger] [--survival-ws ignore|strict]
               [--progress json]         machine-readable progress on stderr (for the status panel)
strata serve [--port 7420] [--no-open]  serve every cached repo; the UI has a repo picker + "add URL"
strata render <repo> --view dashboard|treemap|tree|area|bars --mode fixed:60s|commits:30/s|calendar:7d/s
              --size 1920x1080 --fps 60 --format mp4|gif [--from <rev|date>] [--to ...] -o out.mp4
strata list | strata gc [--older-than 90d] | strata bench <repo>
```

URLs are mirrored into `~/.cache/strata/clones/<host>/<path>.git` with `git clone --mirror`, and
`git fetch` on re-runs. Forgejo is just `ssh://git@git.example.com:2222/you/<repo>.git`.
Private GitHub works through the user's existing git credentials.

---

## 4. Extraction engine (Rust)

### 4.1 Walk
1. Resolve the branch (default: the remote HEAD or `main`/`master`). Walk the **first-parent chain**
   oldest to newest. These are the **steps** (`step = 0..N`).
2. For every merge step, enumerate the side commits it brought in (`P1..M` minus the first-parent
   chain): sha, author, author time, summary. The data comes from the rev walk alone (cheap), with
   no diffs. It's used for hover ("brought in 312 commits by 45 authors"), search, and mapping tags
   on side branches to the step where they landed.
3. Edge cases: multiple roots or subtree merges (git.git pulled in gitk) arrive as a merge step and
   are attributed correctly by blame. Shallow clones start with one giant "import" step, flagged in
   the UI. Octopus merges diff against the first parent like any other merge. An empty repo gives a
   friendly error.

### 4.2 Diff per step (parallel)
For each step, diff the parent tree against the commit tree with **rename tracking** (git-compatible
50% similarity, copies off, a configurable rename limit). For each changed path:
- classify it (§4.4)
- binary (NUL in the first 8000 bytes, or `-diff`/`binary` in gitattributes): record bytes only
- text: diff the blobs with imara-diff histogram and emit the hunks plus `adds`/`dels`
- oversize blobs (configurable, default 16 MB): no diff. Record the line-count delta and flag
  `approx`

Diffing is embarrassingly parallel across steps. A rayon pool produces per-step results into a
**reorder buffer** that feeds the single-threaded tracker in step order, with bounded memory.
Each thread keeps its own gix object cache.

### 4.3 Whitespace, recorded twice
Each text change also gets diffed on whitespace-normalized line tokens, giving `adds_ws`/`dels_ws`.
Imara-diff interns tokens, so this is a second cheap diff on the same input. The UI toggle only
changes which column is summed. Survival tracking uses the whitespace-insensitive alignment by
default (§1).

### 4.4 Classification (stored per path, applied as query-time filters)
- `category`: `source | docs | data | notebook | lockfile | vendored | generated | binary | submodule`
- rules, in order: `.gitattributes` `linguist-vendored`/`linguist-generated`/`linguist-documentation`,
  then a built-in table (lockfile names, `node_modules/`, `vendor/`, `dist/`, `build/`, `*.min.*`,
  "Code generated … DO NOT EDIT" headers), then extension-based defaults
- `lang`: an extension/filename table generated at build time from linguist's `languages.yml`
  (vendored snapshot), with linguist's colors reused as the default palette hints
- defaults off in the UI: `lockfile`, `vendored`, `generated`, `binary`

### 4.5 Line tracker: survival without running blame everywhere
The tracker is the heart of the survival, line-age and top-author features.
- State: `HashMap<PathId, Rle<OriginId>>`, where each file is a run-length-encoded vector of the
  origin of each line. An `OriginId` indexes an origin table `(commit time, author_id)`. Runs are
  long in practice, so Linux-scale state should be tens of MB.
- Applying a step: renames move the vector to the new path; hunks splice out deleted runs and splice
  in new runs; deleted files drop their vector. **Every removed line's origin is known at removal**,
  so survival is exact and costs O(changed lines) per step, not O(repo).
- Non-merge step: added lines get origin = this step.
- **Merge step:** added lines are resolved with
  `git blame --incremental -L <added ranges> <M> ^<P1> -- <file>`. The range is limited to the side
  branch, so it's cheap. Lines blamed on the boundary come from `P1`, and lines from conflict
  resolution get origin = `M`. Files are blamed in parallel. `--merge-attribution=merger` skips this
  and uses `M`.
- **Running aggregates per file** (updated with each delta, O(changed lines)): mean origin time,
  per-author line counts, top author and share. Each change event carries these, so line-age and
  top-author coloring are exact at every step without scanning files.
- **Origin deltas:** every step emits `(step, path, cohort_month, author, ±lines)` for each distinct
  (cohort, author) it touched. Cohort and author survival areas are then cumulative sums, filterable
  by path, category and language at query time.

### 4.6 Identities
1. Apply `.mailmap` (gix supports it).
2. Union-find auto-merge: same email (case-folded); GitHub noreply `\d+\+user@users.noreply…` maps
   to `user`; same normalized full name (lowercase, accents and punctuation stripped, ≥2 tokens, and
   never generic names like `root`, `unknown` or `ubuntu`).
3. Per-repo overrides in the config (§4.8) win over everything.
4. Bots: `[bot]` suffix, dependabot, renovate, github-actions, pre-commit-ci, weblate and a few
   others, plus overrides. `is_bot` is a column, so hiding or grouping bots is a UI toggle.

### 4.7 Incremental resume
- `meta.json` records the schema version, engine version, the settings that affect extraction,
  the last processed step and sha, and the branch.
- `checkpoint.bin` (bincode or zstd) holds the tracker state, the per-file aggregates, the path
  interner, the identity map and the origin table.
- On re-run: fetch, then check that the last sha is still on the new first-parent chain. If it is,
  process only the new steps and write new Parquet part files. If history was rewritten or a setting
  changed, do a full re-extract and say why.
- Checkpoints are also written periodically during long runs, so a killed Linux extraction resumes
  instead of restarting.

### 4.8 Per-repo config
`.strata.toml` in the repo if present, otherwise `~/.cache/strata/<repo-id>/strata.toml`, holds
identity merges and splits, bot list additions, classification overrides (globs → category), the
default branch, and default UI settings.

### 4.9 Progress and the status panel
`--progress json` emits `{steps_done_this_run, steps_total_this_run, phase, eta_s}` lines. The ETA
comes from the engine, which knows its phase mix. Long runs (the Linux benchmark) are published to
the "Working on" panel from a 30 s heartbeat wrapper. `--step` counts only steps finished in this
run, and `--eta` comes from the engine, never a straight line from counts.

---

## 5. Storage and query layer

### 5.1 Layout: `~/.cache/strata/<repo-id>/`

```
meta.json   checkpoint.bin   strata.toml?
steps/part-00000.parquet ...       one row per first-parent step
side_commits/part-*.parquet        commits brought in by merges
changes/part-*.parquet             one row per (step, path) change
origin_deltas/part-*.parquet       survival deltas
keyframes/kf-<step>.parquet        full file state snapshots
paths.parquet  authors.parquet  tags.parquet     small, rewritten each run
```

### 5.2 Tables

- **steps**: `step u32, sha, author_id, committer_id, author_time i64, commit_time i64,
  axis_time i64 (monotonic), is_merge, side_count u32, summary, message, adds, dels, adds_ws,
  dels_ws, files_changed, flags (import|approx|shallow_root)`
- **side_commits**: `sha, landing_step, author_id, author_time, summary`
- **changes**: `step, path_id, kind (A|M|D|R), old_path_id?, adds, dels, adds_ws, dels_ws,
  lines_after, bytes_after, mean_origin_time_after f32, top_author_after, top_share_after f16`
- **origin_deltas**: `step, path_id, cohort_month u16, author_id, delta i32`
- **keyframes**: `kf_step, path_id, lines, bytes, mean_origin_time, top_author, top_share`
- **paths**: `path_id, path, lang, category, first_step, last_step`
- **authors**: `author_id, name, email, is_bot, alias_count`
- **tags**: `name, sha, step, time, on_main bool`

Files are sorted by `step`, so the Parquet row-group statistics prune time-range queries.
Keyframes go every K steps, with K chosen so a keyframe holds about as many rows as the change
events between two keyframes. That bounds state reconstruction to one keyframe plus fewer than K
steps of events.

### 5.3 Queries (DuckDB, server-side)
- **Bins:** the client sends `bins = canvas pixel width`. The server aggregates per bin on the
  commit-index or axis-time axis. Bars get `sum adds, sum dels, max single step, count`; area gets
  per-slice series. Zoomed in far enough, one bin equals one step.
- **State at step s:** load the nearest keyframe ≤ s, union the changes in (kf, s], and take the
  last value per path with `arg_max`. Drill-down is a `path LIKE 'root/%'` filter.
- **Filters** apply to every query: categories, languages, root dir, authors, hide bots,
  whitespace mode, time range.
- **Survival area:** `SUM(delta) GROUP BY bin, cohort`, then a cumulative window. Top N layers,
  the rest become "other".
- Hot aggregates (for example deltas pre-summed by top-level dir) are materialized lazily if Linux
  profiling shows they're needed. There's also an LRU result cache keyed by (query, filters).

---

## 6. HTTP API (axum)

| Endpoint | Returns |
|---|---|
| `GET /api/repos` · `POST /api/repos {source}` | cached repos; add a repo or start extraction and return a job id |
| `GET /api/jobs/:id/events` | SSE progress (phase, steps, ETA), which drives the loading screen |
| `GET /api/r/:repo/meta` | step count, time range, tags, languages, categories, top dirs, authors |
| `GET /api/r/:repo/paths` | Arrow: the path dictionary (id, path, lang, category) |
| `GET /api/r/:repo/bars?from&to&bins&axis&filters` | Arrow: binned adds and dels |
| `GET /api/r/:repo/area?…&slice=dir\|lang\|author\|cohort&mode=size\|flow&depth&top` | Arrow: stacked series |
| `GET /api/r/:repo/state?step&root&filters` | Arrow: file state at a step (lines, bytes, age, top author, last content edit) |
| `GET /api/r/:repo/events?from&to&root&filters` | Arrow: change events for forward playback |
| `GET /api/r/:repo/step/:n` | JSON: commit details, files touched, side commits |
| `GET /api/r/:repo/search?q&kind=path\|author\|message` | matching steps and paths |
| `GET /api/r/:repo/compare?a&b&root&filters` | Arrow: per-path lines at A and B |
| `GET /api/r/:repo/keys?…area params` | Arrow: the keys an area query labels, best first (§13) |
| `GET /api/r/:repo/composition?slice&unit&keys&mode&from&to` | Arrow: per file and tracked key, surviving lines (size) or lines changed (flow) (§13) |
| `GET /api/r/:repo/origins?…composition params` | Arrow: `composition` rows per step over (from, to], for playback |
| `GET /api/r/:repo/churn?from&to&filters` | Arrow: lines added and deleted per file over (from, to], deleted files included |
| `GET /api/r/:repo/span?from&to&filters` · `/renames?from&to` | Arrow: every file alive in [from, to] with its end size; renames in the range (steady layout) |
| `POST /api/render/:job/frame` | headless render frame sink (§7.2) |

Bulk data travels as Arrow IPC and small payloads as JSON.

---

## 7. Frontend (vanilla TS + D3 + Canvas)

### 7.1 App shell and state
- One observable store holds `repo, cursorStep, brush[a,b]?, compare{a,b}?, root, filters,
  settings`. Views subscribe to the slices they need. There's no framework, just a small
  `subscribe(selector, fn)`.
- **Timeline and playback clock:** the playback mode is selectable:
  - *Fixed duration* (default 60 s): the step is linear in commit index over the chosen runtime.
  - *Commits per second*: adjustable, 1 to 10k/s.
  - *Calendar*: N days per second over `axis_time`, found by binary search into the step times.
  The **axis toggle** (calendar vs index) is independent of the playback mode. Transport: play/pause,
  step back/forward, speed, loop, scrubber with tag ticks, jump to tag.
- **Data during playback:** keep a client-side file map, apply `events` chunks forward, and prefetch
  the next chunk. Scrubbing backwards or jumping requests `state` again. Bars and area are fetched
  binned per zoom level and cached.
- Settings persist in `localStorage` per repo (wrapped in try/catch).

### 7.2 Painter abstraction
Every view renders through `Painter` (`rect, path, line, circle, text, clip, save/restore`).
`CanvasPainter` is used for screen and PNG/video. `SvgPainter` emits an SVG string for vector
export, with the same LOD so a Linux treemap SVG stays usable. Axes and labels are drawn through
the painter too, so exports are complete.

### 7.3 The four views

**Per-commit +/- bars.** Additions go up in green and deletions down in red, with a cumulative net
line on top. Binned when there are more commits than pixels, with a subtle max-in-bin tick.
Settings: y-scale linear/sqrt/symlog; clamp at a percentile (default p99) with a ▲ badge showing
the true value; whitespace-insensitive counts. Hover a bin to see its commits (or the single
commit); click to move the cursor there. Tags are vertical ticks, and search matches are
highlighted bars.

**Stacked area.** The slice dropdown offers dir (depth 1–3), lang, author (surviving lines), and
**cohort** (survival layers by year, quarter or month). Mode *size* is cumulative; mode *flow*
stacks each bin's adds above the axis and its dels below. The cursor is a vertical line, and a brush
here sets the global time range. Top-N layers plus "other"; click a layer to isolate or drill.

**Animated file tree.** Layout dropdown:
- *Radial tidy tree* (default): deterministic d3 tree in polar coordinates. Layout is recomputed
  when the node set changes (throttled) and positions are tweened.
- *Force-directed (Gource)*: d3-force runs in a Web Worker, and positions come back as transferable
  Float32Arrays each tick.
- *Icicle/sunburst*: d3 partition sized by lines, with a radial or linear orientation toggle.

Files are leaf dots with area ∝ lines; directories are joints; edges are batched into one canvas
path. A **node budget** (default 8k) collapses the deepest directories into aggregate nodes, which
re-expand on drill-down. Files touched at the current step flash green (net add) or red (net del)
and decay. **Author actors** (toggle): initials badges, with opt-in Gravatar, beam to touched files
and ease between them. Merge steps show at most the top K authors.

**Evolving treemap.** Stable order: siblings are sorted by `first_step` then path, never by size.
Tiling is `treemapBinary`, which preserves order and stays reasonably square. A spike (M1) compares
it against `treemapResquarify` and strip/pivot ordered layouts for stability versus aspect ratio.
Rectangles tween between frames. LOD: nothing under ~2 px² is drawn and its area goes to the
parent. Directory labels are clipped to their rectangles. Click a directory to zoom in, with a
breadcrumb back out.

**Color-by** (tree and treemap): language (linguist colors, default), recent-activity heat,
line age (sequential, from `mean_origin_time`), top author (categorical over the top 12 authors,
the rest grey). Every color scheme is checked in light and dark themes.

### 7.4 Interactions
- **Hover:** commit, file or layer card with message, author(s), SHA, dates, +/-, files touched,
  side commit count, and "brought in N commits by M authors".
- **Drill into folders:** sets `root` globally, so all four views refilter.
- **Brush a time range:** sets `brush` globally. Tree and treemap show only that window's changes
  (heat and deltas); bars and area zoom.
- **Compare A/B:** pick two points (shift-click or date inputs).
  - Treemap overlay: size = B, diverging color = log2(B/A); born files bright, dead files as
    ghost outlines.
  - Side-by-side: the same layout is computed on A ∪ B so positions correspond.
  - Tree: nodes colored born, died, grew or shrank.
  - Area/bars: an A–B band.
  - Summary table: top growers and shrinkers.
- **Search:** path, author or message text. Matches glow in every view, and ↑/↓ jump between
  matching steps.
- **Settings panel:** the exclusion toggles, whitespace mode, bar scale and clamp, axis mode,
  playback mode and duration, slice and depth, tree layout, color-by, author actors, hide bots,
  node budget, theme.

### 7.5 Export
- **PNG:** any view or the whole dashboard, composited offscreen at 1×, 2× or 4×.
- **SVG:** re-render the current frame through `SvgPainter`.
- **MP4 (in-browser):** a deterministic frame loop. For each frame, set the cursor, await the data,
  render to an OffscreenCanvas, and encode with WebCodecs `VideoEncoder` into an MP4 via the muxer.
  No dropped frames, and the chosen resolution is independent of the window.
- **GIF:** the same loop, quantized with `gifenc` at a capped resolution and fps.
- **Headless batch** (`strata render`): start the server on a random port, then launch headless
  Firefox or Chrome with an isolated profile against `/?render=<job>`. The page runs the same
  deterministic loop but POSTs each frame as PNG to `/api/render/:job/frame`, which pipes into
  `ffmpeg` (`image2pipe`, then libx264 or `palettegen`/`paletteuse` for GIF). The browser is killed
  on completion. No CDP dependency.

---

## 8. Testing and validation

- **Fixture repos** (`fixtures/make.sh`, deterministic dates and authors): linear history, rename
  plus edit, directory move, merge with conflict resolution, octopus merge, subtree merge with an
  unrelated root, whitespace-only reformat, binary file, lockfile churn, vendored dir, submodule,
  mailmap aliases, bot commits, force-push rewrite (for resume), shallow clone.
- **Oracles against git itself:**
  - Per-step adds and dels equal `git log --first-parent -M --diff-algorithm=histogram --numstat`,
    and the `-w` variant.
  - Tracker line count per file at sampled steps equals the line count of the blob at that step.
  - Survival: origin authors and times at sampled steps match `git blame` (histogram) for a sample
    of files, within a documented tolerance for diff-alignment differences.
- **Rust unit tests:** RLE splice ops (property-based via `proptest` against a naive `Vec`),
  identity union-find, classification rules, the reorder buffer, checkpoint round-trip.
- **Frontend (Vitest):** playback-mode mappings, axis monotonicity, binning, stable treemap
  ordering (positions don't swap when sizes change), node-budget collapsing, Painter parity
  (Canvas and SVG produce the same op list).
- **Smoke:** headless-browser screenshots of the dashboard on fixtures and on this repo itself,
  at desktop and narrow widths.
- **Benchmarks:** `strata bench` on the corpus below records time, peak RSS, output size and
  query latencies (p50/p95) for each endpoint.

### Benchmark corpus
| Tier | Repos | Purpose |
|---|---|---|
| small | this repo and a couple of small self-hosted repos | daily dev loop, <5 s end to end |
| mid | git/git, cpython | merge-heavy and long histories, rename and subtree edge cases |
| huge | torvalds/linux | the scale target |

**Targets** (to be validated in M3, not promises):
- Linux full extraction in ≤ 60 min on the desktop, with peak RSS ≤ 4 GB (only ~6 GB is free
  day-to-day on this machine).
- Every UI query returns in ≤ 300 ms p95 on Linux.
- Playback holds 60 fps on the 5k-commit tier and ≥ 30 fps on Linux with LOD.

---

## 9. Milestones

Each milestone ends with a working `strata` on real repos, and every step is committed and pushed
to Forgejo as it lands.

### M0: scaffolding
- `git init`, Cargo workspace with the four crates, Vite + TS project, `.gitignore`, `cargo fmt`,
  `clippy -D warnings`, `tsc --noEmit`, `vitest`, one `make check` (or `just`) target.
- `fixtures/make.sh` with the first three fixture repos.
- Push to Forgejo (`strata`).

### M1: vertical slice, all four views rough (the chosen first milestone)
- Engine, sequential: first-parent walk, tree diff + renames, imara-diff counts, basic
  classification, a line tracker with merges attributed to the merger, Parquet out, `meta.json`.
  No resume yet.
- Server: `meta`, `paths`, `bars`, `area` (dir/lang, size mode), `state`, `events`.
- Web: store + fixed-duration playback + scrubber; `CanvasPainter`; bars (binned, linear);
  area (dir); radial tidy tree; stable treemap (`treemapBinary`); color by language; basic hover.
- Treemap tiling spike (binary vs resquarify vs strip).
- **Exit:** `strata ~/Projects/myrepo` opens a dashboard where all four views move together, and the
  numbers match the git oracle on the fixtures.

### M2: correct data
- Merge attribution by ranged blame; side commits; tags mapped to steps.
- `.mailmap`, identity heuristics, bots, the per-repo config.
- Full classification (gitattributes, linguist table), the whitespace dual counts, binary bytes,
  oversize handling.
- Origin deltas, cohort and author survival areas, per-file age and top-author aggregates, keyframes.
- Incremental resume, periodic checkpoints, rewrite detection.
- The complete oracle suite, green on all fixtures and on git/git.

### M3: scale
- Parallel diff pipeline with reorder buffer, a tuned memory budget, RLE tracker profiling.
- Binned/LOD endpoints, Arrow transport, lazy materialized aggregates, result cache.
- Frontend LOD: canvas culling, node budget, force layout in a worker, chunk prefetch.
- Benchmarks on cpython, then Linux, run on the status panel. Fix whatever breaks the targets.

### M4: every view and interaction, finished
- The three tree layouts, author actors, all four color-by modes, heat decay.
- The three playback modes, axis toggle, area flow mode, and every outlier setting.
- Hover cards, drill-down + breadcrumb, brush, compare A/B (overlay + side-by-side), search
  highlight, tags on the scrubber, settings panel, light and dark themes.

### M5: export
- `SvgPainter` parity, PNG/SVG export.
- WebCodecs MP4 and GIF with a deterministic frame loop.
- `strata render` via headless browser + ffmpeg.

### M6: hardening and release
- Edge cases: non-UTF-8 paths, huge single files, shallow and partial clones, octopus merges, empty
  repos, missing branch, clone failures, disk full.
- README with screenshots, `cargo install --path crates/strata-cli`, release profile (LTO), a
  single-binary build check.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Linux extraction too slow or memory-hungry (desktop has ~6 GB free) | parallel diff, RLE tracker, a bounded reorder buffer, periodic checkpoints (resume instead of restart), `--merge-attribution=merger` fast mode |
| Blame on big merges dominates runtime | ranged blame limited to the side branch and only added ranges; parallel per file; measured in M3 with fallback to merger mode per merge above a size threshold |
| Canvas can't hold 60 fps with 80k treemap rects | LOD culling, node budget, dirty-rect redraws; a raw WebGL2 instanced-rect path as a contained escape hatch behind `Painter` |
| DuckDB queries over ~100M origin-delta rows feel slow | step-sorted row groups, lazy materialized aggregates, a result cache, sending fewer bins while scrubbing |
| Force layout jitter makes "compare two dates" meaningless | compare mode forces a deterministic layout (tidy or icicle); force layout is for show |
| gix and git diff counts disagree | histogram on both sides in the oracle, with documented tolerance; a `git`-CLI fallback diff path behind a flag for debugging |
| Treemap stability versus aspect ratio | tiling spike in M1; the choice lives behind one function |
| DuckDB bundled build is slow to compile | acceptable; it's a one-time cost, and incremental builds are unaffected |

---

## 11. Open questions for later
- A cap on stored side-commit messages for Linux (search needs them; size TBD after M3).
- Whether to also offer an "all commits, flattened" timeline later. The data model already
  records side commits, so it would be additive.
- A human vs AI-coauthored slice from `Co-Authored-By` trailers (declined for now, cheap to add
  later because the messages are stored).

---

## 12. Build status and deviations (2026-09-27)

Everything in §1–§9 is implemented. The history is in the commits; the design changed in these
places while building:

| Plan | What was built | Why |
|---|---|---|
| Bars: a cumulative net-lines line on top | Dropped | A second measure on its own scale is a dual-axis chart. Cumulative size is the stacked area's job. |
| Adds/dels green and red | Blue/red by default, classic green/red as a setting | Green/red measured ΔE 6.9–7.2 under deuteranopia (the colorblind warn band). Blue/red measured 21.6 light, 19.2 dark. |
| Category chips in the filter row | One "Files" menu | Nine chips wrapped the row on real repos. |
| Area top-N = 12 | Top 8 plus "(other)" | The validated categorical palette has 8 slots and hues are never cycled. |
| Language colors from linguist | 8 fixed slots, ranked by current size | The linguist palette is a rainbow of 500+ hues. |
| Merge attribution by ranged `git blame` | Side-branch replay in-process, `git blame --root P1..M` only as a fallback | 4× faster on git/git (101 s → 25.6 s). Agrees with `git blame -w HEAD` on 99.1% of lines. |
| Tree node budget (breadth-first) | Loose-file grouping, a depth cap, then bottom-up collapse to the card's leaf capacity | A breadth-first budget produced solid fans and squeezed rings on real repos. |
| Parquet written with arrow-rs | Written through an in-memory DuckDB (`COPY … TO`) | One dependency (DuckDB) instead of two (DuckDB plus parquet). |
| Headless render via frame capture | The page renders frames and POSTs PNGs, piped into ffmpeg | No CDP dependency; works with Chrome and Firefox. |
| Cohort unit per year | `auto`: month under 2 years of history, quarter under 6, year beyond | Young repos showed a single layer. |

Measured (desktop, 12 threads): git/git, 24,344 first-parent steps, extracts in 25.6 s with
~770 MB peak anonymous memory and a 10.8 MB cache. Every query stays under 50 ms at p95.

Linux (77,194 first-parent steps; the scale target):

| Target (§8) | Result |
|---|---|
| Extraction ≤ 60 min | Met: ~36 min, plus ~30 min to clone. The run was interrupted once and resumed on a newer engine. |
| Peak RSS ≤ 4 GB | Met: 1.0–1.6 GB anonymous memory, plus the memory-mapped pack, which is reclaimable. |
| UI queries ≤ 300 ms p95 | Met at p50: every cold query is at or under ~285 ms (area by author 274 ms, message search 285 ms), and cached calls take < 3 ms. Over it at cold p95: the first area query per slice builds its aggregate once (up to ~490 ms), and message search reaches ~310 ms. Measured at load average ~15. |
| Playback ≥ 30 fps with LOD | Not met: ~17 fps in Chrome on the desktop GPU with ~60k cells, measured at load average 15. A WebGL treemap layer and LOD got it there from 3.4 fps. |
| Survival within tolerance of blame | git/git 99.1% of lines. Linux 90.1% on 20 files: the most recent 16k steps were extracted before merge-aware replay existed. Re-extract with `--full` to re-check. |

Additions not in the original plan: the WebGL2 treemap layer (§10's escape hatch), per-repo
lazy aggregates, the query cache, `strata bench --verify` and `tools/smoke.mjs` (make smoke).

---

## 13. The treemap as a data window (2026-09-29)

"Files by size" can now show everything the stacked area can, plus recency, zoom and a steady
playback layout:

- **Show:** directory, language, author, when written, last edited, recent activity; a depth or
  cohort unit when it applies. Colors are shared with the area chart (`model/slices.ts`).
- **Author and when-written bands:** each file is split into strips by its surviving lines per
  key. The keys are exactly the area chart's labels: `/keys` runs the same ranking SQL
  (`rank_sql`, now ranked per step, so it no longer depends on the bin count), and author color
  slots go to those authors by surviving lines instead of the top committers. The breakdown is
  a `StateSync` layer (`model/composition.ts`) loaded with `/state` and advanced from `/origins`
  chunks, so it never disagrees with the tree.
- **Last edited:** yellow (just edited) through orange to deep red (untouched longest), on a log
  time scale from the cursor. `edited` is the step that
  last changed a file's content; a pure move keeps its source's (the store derives
  `rename_edits`, ~20k rows on Linux, once per load). No re-extraction.
- **Sized by lines changed:** every text file changed from the range start to the cursor, deleted
  files included (`model/churn.ts`, loaded from `/churn`, then added up from the same `/events`
  rows while playing). Bands switch to lines changed per key, with a rename's moved lines netted
  out.
- **Zoom and pan** in the treemap (semantic: laid out at the zoomed size, so folders open into
  files) and every tree layout (geometric; labels appear as room opens). On phones a one-finger
  drag scrolls the page until a card is zoomed in.
- **Steady layout:** the binary tiling is recorded at the end of the range (every cut and each
  folder's padding) and replayed with the current sizes, so files grow and shrink in place; a
  rename lineage keeps moved content where it ends up. The last frame equals the live treemap
  (0 px difference on git/git).

| Plan | What was built | Why |
|---|---|---|
| `kf_edits` snapshots per keyframe | One aggregate over `changes` up to the step | 15–20 ms at Linux's HEAD (1.7M rows). A left-only term in the join's ON clause had made it 4.4 s; it's gone. |
| Composition snapshots per keyframe if slow | Plain queries | 90–200 ms at Linux's HEAD (5.1M origin rows); 12 ms per playback chunk. |
| Tree zoom raises the node budget | Geometric zoom, more labels | More leaves reshuffle the radial, sunburst and icicle angles, including the zoomed region. |
| Frozen padding replayed as is | Capped at 45% of the folder's extent | Folders far smaller than at the end collapsed under their headers. |

Found on the way: the WebGL treemap came up blank until something redrew it (the first frame
after a layout painted the 2D canvas opaque over the fills), and a folder's sort order depended
on which of its files was loaded first. Both are fixed.

Measured on Linux at step 40,000 (37k files, `--gpu`, load ~1.3), playing:

| Treemap | Frame (mean / p95) | fps |
|---|---|---|
| Language, live | 13–16 / 33–36 ms | 35–40 |
| Author bands, live | 25–28 / 46–50 ms | 22–24 |
| Author bands, steady | 29–32 / 100–109 ms | 21–22 |

A steady relayout re-tiles every file the range ever had: 96 ms against 28 ms live, so the
relayout throttle adapts to at most a quarter of the time. On git/git the steady layout moves
files 5–10× less between nearby commits (mean center shift 11.5 → 1.9 px over 100 commits).
Author mode costs ~28 ms a frame even with the strips turned off, so the gap to language mode
is elsewhere in that path; not yet profiled.
