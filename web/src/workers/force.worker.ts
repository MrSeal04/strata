/// <reference lib="webworker" />
// Force-directed (Gource-style) layout off the main thread. Receives the visible node set,
// keeps positions across updates, and streams positions back while the simulation is warm.
import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3";

interface N extends SimulationNodeDatum {
  id: string;
  r: number;
  dir: boolean;
}

export interface SyncMsg {
  type: "sync";
  version: number;
  ids: string[];
  parents: Int32Array;
  radius: Float32Array;
  dirs: Uint8Array;
}

const known = new Map<string, N>();
let nodes: N[] = [];
let version = 0;
const sim = forceSimulation<N>([])
  .alphaDecay(0.03)
  .velocityDecay(0.35)
  .force("charge", forceManyBody<N>().strength((d) => (d.dir ? -40 : -8)).distanceMax(400))
  .force("x", forceX<N>(0).strength(0.02))
  .force("y", forceY<N>(0).strength(0.02))
  .stop();

let timer: ReturnType<typeof setInterval> | null = null;

function post() {
  const xy = new Float32Array(nodes.length * 2);
  nodes.forEach((n, i) => {
    xy[i * 2] = n.x ?? 0;
    xy[i * 2 + 1] = n.y ?? 0;
  });
  (self as unknown as Worker).postMessage({ type: "pos", version, xy }, [xy.buffer]);
}

function run() {
  if (timer) return;
  timer = setInterval(() => {
    for (let i = 0; i < 2; i++) sim.tick();
    post();
    if (sim.alpha() < sim.alphaMin()) {
      clearInterval(timer!);
      timer = null;
    }
  }, 16);
}

self.onmessage = (e: MessageEvent<SyncMsg>) => {
  const m = e.data;
  if (m.type !== "sync") return;
  version = m.version;
  const next: N[] = [];
  for (let i = 0; i < m.ids.length; i++) {
    let n = known.get(m.ids[i]);
    if (!n) {
      const p = m.parents[i] >= 0 ? next[m.parents[i]] : undefined;
      const jitter = () => (Math.random() - 0.5) * 20;
      n = { id: m.ids[i], r: m.radius[i], dir: m.dirs[i] === 1, x: (p?.x ?? 0) + jitter(), y: (p?.y ?? 0) + jitter() };
      known.set(n.id, n);
    }
    n.r = m.radius[i];
    n.dir = m.dirs[i] === 1;
    next.push(n);
  }
  const live = new Set(m.ids);
  for (const id of known.keys()) if (!live.has(id)) known.delete(id);
  nodes = next;
  const links = [];
  for (let i = 0; i < nodes.length; i++) {
    const p = m.parents[i];
    if (p >= 0) links.push({ source: nodes[p], target: nodes[i], dir: nodes[i].dir });
  }
  sim.nodes(nodes);
  sim.force(
    "link",
    forceLink(links)
      .distance((l: { dir: boolean }) => (l.dir ? 38 : 14))
      .strength(0.9),
  );
  sim.alpha(Math.max(sim.alpha(), 0.35));
  run();
};
