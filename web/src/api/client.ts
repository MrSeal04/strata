import { type Table, tableFromIPC } from "apache-arrow";
import type { State } from "../state/store";

export type RepoSource = { kind: "path"; path: string } | { kind: "url"; url: string };

export interface RepoMeta {
  id: string;
  name: string;
  source: RepoSource;
  branch: string;
  head: string;
  steps: number;
  first_time: number;
  last_time: number;
  updated_at: number;
  last_run: Record<string, unknown>;
}

export interface JobProgress {
  phase: string;
  done: number;
  total: number;
  steps_per_sec: number;
  eta_secs: number | null;
  message: string | null;
}

export interface JobStatus {
  id: string;
  repo: string;
  source: RepoSource;
  /** "credentials": the remote wants a login (`rejected`: it refused the one sent). */
  state: "running" | "done" | "failed" | "cancelled" | "credentials";
  error?: string;
  host?: string;
  rejected?: boolean;
  progress: JobProgress;
}

/** A login for a private HTTP(S) remote; the server keeps it in memory only. */
export interface Login {
  username: string;
  password: string;
}

export interface Summary {
  head: { steps: number; first_time: number; last_time: number; adds: number; dels: number; merges: number };
  tags: { name: string; step: number; time: number; on_main: boolean }[];
  langs: { lang: string; files: number; lines: number }[];
  categories: { category: number; paths: number }[];
  authors: number;
}

export interface Author {
  id: number;
  name: string;
  email: string;
  is_bot: boolean;
  commits: number;
}

export const CATEGORY_NAMES = [
  "source", "docs", "data", "notebook", "lockfile", "vendored", "generated", "binary", "submodule",
];

export class ApiError extends Error {}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((body as { error?: string }).error ?? `${r.status} ${r.statusText}`);
  return body as T;
}

async function arrow(url: string, signal?: AbortSignal): Promise<Table> {
  const r = await fetch(url, { signal });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new ApiError((body as { error?: string }).error ?? `${r.status} ${r.statusText}`);
  }
  return tableFromIPC(new Uint8Array(await r.arrayBuffer()));
}

/** Numeric column as Float64Array (nulls -> `nullAs`). */
export function col(t: Table, name: string, nullAs = 0): Float64Array {
  const v = t.getChild(name);
  const out = new Float64Array(t.numRows);
  if (!v) return out;
  const raw = v.toArray() as ArrayLike<number | bigint>;
  const hasNulls = v.nullCount > 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = hasNulls && !v.isValid(i) ? nullAs : Number(raw[i]);
  }
  return out;
}

export function strCol(t: Table, name: string): string[] {
  const v = t.getChild(name);
  if (!v) return [];
  const out: string[] = new Array(t.numRows);
  for (let i = 0; i < t.numRows; i++) out[i] = (v.get(i) as string | null) ?? "";
  return out;
}

export function boolCol(t: Table, name: string): Uint8Array {
  const v = t.getChild(name);
  const out = new Uint8Array(t.numRows);
  if (!v) return out;
  for (let i = 0; i < t.numRows; i++) out[i] = v.get(i) ? 1 : 0;
  return out;
}

/** Query-string for the global filters. */
export function filterParams(s: State): URLSearchParams {
  const p = new URLSearchParams();
  p.set("exclude", s.settings.exclude.join(","));
  if (s.langs.length) p.set("langs", s.langs.join(","));
  if (s.root) p.set("root", s.root);
  if (s.authors.length) p.set("authors", s.authors.join(","));
  if (s.settings.hideBots) p.set("bots", "0");
  if (s.settings.ws) p.set("ws", "1");
  return p;
}

const base = (repo: string) => `/api/r/${encodeURIComponent(repo)}`;

export const api = {
  repos: () => json<{ repos: RepoMeta[]; jobs: JobStatus[] }>("/api/repos"),
  addRepo: (source: string, full = false, login?: Login) =>
    json<JobStatus>("/api/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, full, ...login }),
    }),
  job: (id: string) => json<JobStatus>(`/api/jobs/${id}`),
  cancelJob: (id: string) => json<unknown>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  jobEvents: (id: string) => new EventSource(`/api/jobs/${id}/events`),
  meta: (repo: string) =>
    json<{ meta: RepoMeta; summary: Summary; job: JobStatus | null }>(`${base(repo)}/meta`),
  axis: (repo: string) => arrow(`${base(repo)}/axis`),
  paths: (repo: string) => arrow(`${base(repo)}/paths`),
  authors: (repo: string) => json<Author[]>(`${base(repo)}/authors`),
  bars: (repo: string, p: URLSearchParams, signal?: AbortSignal) => arrow(`${base(repo)}/bars?${p}`, signal),
  area: (repo: string, p: URLSearchParams, signal?: AbortSignal) => arrow(`${base(repo)}/area?${p}`, signal),
  state: (repo: string, p: URLSearchParams, signal?: AbortSignal) => arrow(`${base(repo)}/state?${p}`, signal),
  events: (repo: string, p: URLSearchParams, signal?: AbortSignal) => arrow(`${base(repo)}/events?${p}`, signal),
  compare: (repo: string, p: URLSearchParams, signal?: AbortSignal) => arrow(`${base(repo)}/compare?${p}`, signal),
  step: (repo: string, n: number) => json<StepDetail>(`${base(repo)}/step/${n}`),
  commits: (repo: string, p: URLSearchParams) => json<CommitRow[]>(`${base(repo)}/commits?${p}`),
  search: (repo: string, q: string, kind: string) =>
    json<{ steps: number[]; paths: number[] }>(`${base(repo)}/search?${new URLSearchParams({ q, kind })}`),
  dirs: (repo: string, p: URLSearchParams) => json<{ name: string; is_dir: boolean; lines: number; files: number }[]>(`${base(repo)}/dirs?${p}`),
};

export interface CommitRow {
  step: number;
  summary: string;
  author: string;
  time: number;
  adds: number;
  dels: number;
  is_merge: boolean;
  side_count: number;
}

export interface StepDetail {
  commit: {
    step: number;
    sha: string;
    author_time: number;
    commit_time: number;
    axis_time: number;
    is_merge: boolean;
    side_count: number;
    summary: string;
    message: string;
    adds: number;
    dels: number;
    adds_ws: number;
    dels_ws: number;
    files_changed: number;
    flags: number;
    author: string;
    author_email: string;
    author_id: number;
    committer: string;
  } | null;
  files: {
    path: string;
    kind: number;
    adds: number;
    dels: number;
    lines_after: number;
    binary: boolean;
    category: number;
    lang: string;
    old_path: string | null;
  }[];
  side_authors: { name: string; commits: number }[];
  tags: { name: string }[];
}
