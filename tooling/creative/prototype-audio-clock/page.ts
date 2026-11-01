/* eslint-disable @typescript-eslint/no-explicit-any, func-style, unicorn/prefer-top-level-await -- throwaway prototype (#1888) */
// PROTOTYPE (#1888), throwaway. The page: an AudioContext, the click worklet,
// the Play worker, clock anchors, a button, and the numbers.
type Report = {
  at: number;
  extra?: Record<string, number>;
  frame: number;
  headroom: number;
  ideal?: number;
  kind: string;
  late: boolean;
  lateBy: number;
  sampleRate: number;
};
const reports: Report[] = [];
const presses = new Map<number, number>(); // press id -> audio time of the event
let ctx: AudioContext;
let worker: Worker;
let node: AudioWorkletNode;
const visibility: string[] = [];
document.addEventListener('visibilitychange', () =>
  visibility.push(`${document.visibilityState}@${ctx?.currentTime.toFixed(2)}`),
);

const anchor = () => {
  // currentTime moves a render quantum at a time; take the freshest pairing.
  worker.postMessage({
    type: 'anchor',
    ctx: ctx.currentTime,
    perf: performance.timeOrigin + performance.now(),
  });
};

async function setup(config: Record<string, unknown> = {}) {
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('./worklet.js');
  node = new AudioWorkletNode(ctx, 'proto-click');
  node.connect(ctx.destination);
  node.port.onmessage = e => reports.push(e.data);
  worker = new Worker('./worker.js', { type: 'module' });
  const ch = new MessageChannel();
  node.port.postMessage({ port: ch.port1 }, [ch.port1]);
  worker.postMessage({ type: 'port', port: ch.port2 }, [ch.port2]);
  worker.postMessage({ type: 'config', config });
  await ctx.resume();
  anchor();
  setInterval(anchor, 250);
}
const start = () => worker.postMessage({ type: 'start' });
async function pause() {
  worker.postMessage({ type: 'pause' });
  await ctx.suspend();
}
async function resume() {
  await ctx.resume();
  anchor();
  worker.postMessage({ type: 'resume' });
}
let pressId = 0;
function press(timeStamp: number) {
  const ev = ctx.currentTime - (performance.now() - timeStamp) / 1000;
  const id = pressId++;
  presses.set(id, ev);
  worker.postMessage({ type: 'press', id });
}
const pct = (xs: number[], p: number) => {
  if (!xs.length) {
    return Number.NaN;
  }
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const summary = (xs: number[], scale = 1000) => ({
  n: xs.length,
  min: +(Math.min(...xs) * scale).toFixed(3),
  p50: +(pct(xs, 50) * scale).toFixed(3),
  p99: +(pct(xs, 99) * scale).toFixed(3),
  max: +(Math.max(...xs) * scale).toFixed(3),
});
async function stats() {
  const w: any = await new Promise(r => {
    worker.addEventListener(
      'message',
      e => e.data.type === 'stats' && r(e.data),
      { once: true },
    );
    worker.postMessage({ type: 'stats' });
  });
  const beats = reports.filter(r => r.kind === 'beat');
  const sr = beats[0]?.sampleRate ?? ctx.sampleRate;
  const err = beats.map(b => b.frame - Math.ceil(b.ideal! * sr)); // samples
  const ticks = reports.filter(r => r.kind === 'tick');
  const tickIntervals = ticks
    .slice(1)
    .map((t, i) => (t.frame - ticks[i]!.frame) / sr - 0.5);
  const press = reports.filter(r => r.kind === 'press');
  return {
    sampleRate: sr,
    baseLatencyMs: ctx.baseLatency * 1000,
    outputLatencyMs: (ctx.outputLatency ?? 0) * 1000,
    visibility,
    beats: {
      count: beats.length,
      late: beats.filter(b => b.late).length,
      sampleErrorMax: Math.max(0, ...err.map(Math.abs)),
      sampleErrors: summary(err, 1),
      headroomMs: summary(beats.map(b => b.headroom)),
      pumpLateMs: summary(beats.map(b => b.extra!.pumpLate!)),
    },
    ticks: ticks.length
      ? {
          count: ticks.length,
          late: ticks.filter(t => t.late).length,
          driftPerTickMs: summary(tickIntervals),
          pumpLateMs: summary(ticks.map(t => t.extra!.pumpLate!)),
        }
      : undefined,
    press: press.length
      ? {
          count: press.length,
          late: press.filter(p => p.late).length,
          eventToRenderMs: summary(
            press.map(p => p.frame / sr - presses.get(p.extra!.press!)!),
          ),
          headroomMs: summary(press.map(p => p.headroom)),
        }
      : undefined,
    worker: {
      pumps: w.pumps,
      wakeLateMs: summary(w.wakeLate),
      pumpMs: summary(w.pumpMs, 1),
    },
  };
}
Object.assign(window, {
  proto: { setup, start, pause, resume, press, stats, reports },
});

// Manual UI.
const params = Object.fromEntries(new URLSearchParams(location.search));
const cfg = {
  lead: Number(params.lead ?? 0.05),
  margin: Number(params.margin ?? 0.015),
  pumpCostMs: Number(params.pumpCostMs ?? 0),
  mode: params.mode ?? 'delivery',
  ticker: params.ticker === '1',
  bpm: Number(params.bpm ?? 120),
};
const pre = document.getElementById('out')!;
document.getElementById('go')!.onclick = async () => {
  await setup(cfg);
  start();
};
document.getElementById('hit')!.onpointerdown = e => press(e.timeStamp);
document.getElementById('pause')!.onclick = () =>
  ctx.state === 'running' ? pause() : resume();
setInterval(async () => {
  if (worker) {
    pre.textContent = JSON.stringify(await stats(), null, 2);
  }
}, 1000);

// Auto mode for measure-hidden.ts: run with the URL's config, then post the numbers.
if (params.auto) {
  (async () => {
    await setup(cfg);
    start();
    await new Promise(r => setTimeout(r, Number(params.auto) * 1000));
    await fetch('/report', {
      method: 'POST',
      body: JSON.stringify(await stats()),
    });
  })();
}
