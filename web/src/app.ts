import type { Author, RepoMeta, Summary } from "./api/client";
import type { CompareCache } from "./model/compare";
import type { Composition } from "./model/composition";
import type { FileTree, Paths } from "./model/filetree";
import type { StateSync } from "./model/sync";
import type { Store } from "./state/store";
import type { Timeline } from "./timeline/axis";
import type { Player } from "./timeline/playback";

/** Everything a view needs, created once per opened repo. */
export interface App {
  repo: string;
  meta: RepoMeta;
  store: Store;
  tl: Timeline;
  paths: Paths;
  tree: FileTree;
  sync: StateSync;
  player: Player;
  summary: Summary;
  authors: Author[];
  authorName(id: number): string;
  openCommit(step: number): void;
  /** Playback speed in steps per second for the current mode (for heat decay). */
  stepsPerSecond(): number;
  compare: CompareCache;
  /** Per-file lines by author or cohort (the treemap's bands), kept in sync with `tree`. */
  composition: Composition;
  /** Set by the video exporter so heat decays at the video's pace. */
  exportRate: number | null;
}
