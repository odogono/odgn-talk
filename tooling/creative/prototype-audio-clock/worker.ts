// PROTOTYPE (#1888), throwaway. The Play worker: one Core Group whose Play
// clock is the audio clock plus a safety margin, pumped at each Pump's
// nextDeadline and at each beat's delivery time (one lead ahead).
import { inlineGrants, newGroup, toValue } from '@northtalk/ts';

const source = `
on beat n
  click n
end beat

on startTicker
  repeat forever
    wait 500 ms
    tick
  end repeat
end startTicker

on press id
  hit id
end press
`;

type Config = {
  bpm: number;
  lead: number;
  margin: number;
  mode: 'delivery' | 'now';
  pumpCostMs: number;
  ticker: boolean;
};
let cfg: Config = {
  lead: 0.05,
  margin: 0.015,
  pumpCostMs: 0,
  mode: 'delivery',
  bpm: 120,
  ticker: false,
};
let anchor = { ctx: 0, perf: 0 };
let out: MessagePort | undefined;
let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let beatIndex = 0;
let origin = 0;
let lastPump = 0; // Play seconds
let pumpClock = 0;
let firedDeadline = Infinity;
let nextDeadline = Infinity;
const stamps = new Map<number, number>();
const wakeLate: number[] = [];
let pumps = 0;
let pumpMs: number[] = [];

const perfAbs = () => performance.timeOrigin + performance.now();
const audioNow = () => anchor.ctx + (perfAbs() - anchor.perf) / 1000;
const playNow = () => Math.max(lastPump, audioNow() + cfg.margin);
const spb = () => 60 / cfg.bpm;
let seq = 0;
const send = (c: Record<string, unknown>) =>
  out!.postMessage({ id: seq++, ...c });

const group = newGroup({ name: 'proto' });
const script = group.load({
  name: 'metro',
  grants: inlineGrants({
    sound: {
      click: (n: unknown) => {
        const k = Number(n);
        const ideal = stamps.get(k)!;
        stamps.delete(k);
        // Delivery mode: the beat's Delivery time (ideal - lead) plus the lead.
        // Now mode: Call.Now() (the Pump's clock) plus the lead.
        const at = cfg.mode === 'delivery' ? ideal : pumpClock + cfg.lead;
        send({
          kind: 'beat',
          at,
          ideal,
          extra: { n: k, pumpLate: pumpClock - (ideal - cfg.lead) },
        });
      },
      tick: () => {
        send({
          kind: 'tick',
          at: pumpClock + cfg.lead,
          extra: { pumpLate: pumpClock - firedDeadline },
        });
      },
      hit: (id: unknown) => {
        // "Now plus margin": the Play clock already is audio time plus margin.
        send({ kind: 'press', at: pumpClock, extra: { press: Number(id) } });
      },
    },
  }),
  source,
});

const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin: a slow Pump
  }
};

const loop = () => {
  timer = undefined;
  if (!running) {
    return;
  }
  const now = playNow();
  const wakeTarget = Math.min(
    nextDeadline,
    origin + beatIndex * spb() - cfg.lead,
  );
  if (Number.isFinite(wakeTarget)) {
    wakeLate.push(now - wakeTarget);
  }
  while (origin + beatIndex * spb() - cfg.lead <= now) {
    stamps.set(beatIndex, origin + beatIndex * spb());
    script.deliver({
      name: 'beat',
      args: [toValue(beatIndex, { numbers: 'integer' })],
    });
    beatIndex++;
  }
  pumpClock = now;
  lastPump = now;
  firedDeadline = nextDeadline;
  const t0 = performance.now();
  busy(cfg.pumpCostMs); // a slow Pump: the commands leave this much later
  const r = group.pump(BigInt(Math.round(now * 1e6)));
  pumpMs.push(performance.now() - t0);
  pumps++;
  nextDeadline =
    r.nextDeadline === undefined ? Infinity : Number(r.nextDeadline) / 1e6;
  const wake = Math.min(nextDeadline, origin + beatIndex * spb() - cfg.lead);
  timer = setTimeout(loop, Math.max(0, (wake - playNow()) * 1000));
};

const kick = () => {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  timer = setTimeout(loop, 0);
};

onmessage = (e: MessageEvent) => {
  const m = e.data;
  switch (m.type) {
    case 'port':
      out = m.port;
      break;
    case 'anchor':
      anchor = { ctx: m.ctx, perf: m.perf };
      break;
    case 'config':
      cfg = { ...cfg, ...m.config };
      break;
    case 'start': {
      running = true;
      origin = Math.ceil((playNow() + cfg.lead + 0.1) / spb()) * spb();
      beatIndex = 0;
      if (cfg.ticker) {
        script.deliver({ name: 'startTicker' });
      }
      kick();
      break;
    }
    case 'pause':
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = undefined;
      break;
    case 'resume':
      running = true;
      kick();
      break;
    case 'press':
      script.deliver({
        name: 'press',
        args: [toValue(m.id, { numbers: 'integer' })],
      });
      kick();
      break;
    case 'stats': {
      postMessage({ type: 'stats', pumps, wakeLate, pumpMs });
      break;
    }
    case 'reset':
      wakeLate.length = 0;
      pumpMs = [];
      pumps = 0;
      break;
  }
};
