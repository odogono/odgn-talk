/* eslint-disable @typescript-eslint/no-explicit-any, no-console -- throwaway prototype (#1888) */
// PROTOTYPE (#1888): `bun tooling/creative/prototype-audio-clock/measure.ts [--headless] [--only name]`
// runs each scenario in a fresh Chromium page and prints its numbers as JSON.
import { chromium, type Page } from 'playwright';
import { server } from './serve';

const headless = process.argv.includes('--headless');
const at = process.argv.indexOf('--only');
const only = at < 0 ? undefined : process.argv[at + 1];
const browser = await chromium.launch({
  headless,
  args: ['--autoplay-policy=no-user-gesture-required'],
  // Let Chromium throttle hidden pages as it does for real users.
  ignoreDefaultArgs: [
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
  ],
});
const context = await browser.newContext();
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

type Scenario = {
  body?: (p: Page) => Promise<void>;
  config: Record<string, unknown>;
  name: string;
  seconds?: number;
};
const presses = async (p: Page, n: number) => {
  const box = (await p.locator('#hit').boundingBox())!;
  for (let i = 0; i < n; i++) {
    await p.mouse.move(box.x + 5, box.y + 5);
    await p.mouse.down();
    await p.mouse.up();
    await wait(137 + Math.random() * 200);
  }
};
const base = { lead: 0.05, margin: 0.015, ticker: true };
const scenarios: Scenario[] = [
  { name: 'baseline delivery', config: base, body: p => presses(p, 30) },
  {
    name: 'baseline now',
    config: { ...base, mode: 'now' },
    body: p => presses(p, 30),
  },
  ...[0, 10, 20, 30, 40, 50, 60, 80].map(c => ({
    name: `pumpCost ${c}ms lead 50`,
    config: { ...base, pumpCostMs: c },
    seconds: 8,
  })),
  ...[30, 20].map(c => ({
    name: `pumpCost ${c}ms lead 100`,
    config: { ...base, lead: 0.1, pumpCostMs: c },
    seconds: 8,
  })),
  ...[0, 2, 5, 10, 15, 20].map(m => ({
    name: `press margin ${m}ms`,
    config: { ...base, margin: m / 1000, ticker: false },
    body: (p: Page) => presses(p, 40),
  })),
  ...[5, 10, 20, 30].map(l => ({
    name: `lead ${l}ms`,
    config: { ...base, lead: l / 1000 },
    seconds: 10,
  })),
  {
    name: 'hidden tab 20s',
    config: base,
    body: async p => {
      // Minimise the window so the page is really hidden.
      const cdp = await context.newCDPSession(p);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      });
      await wait(20_000);
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' },
      });
    },
  },
  {
    name: 'pause 3s then resume',
    config: base,
    body: async p => {
      await wait(4000);
      await p.evaluate(() => (window as any).proto.pause());
      await wait(3000);
      await p.evaluate(() => (window as any).proto.resume());
      await wait(4000);
    },
  },
];

const results: Record<string, unknown> = {};
for (const s of scenarios) {
  if (only && !s.name.includes(only)) {
    continue;
  }
  const p = await context.newPage();
  await p.goto(server.url.href);
  await p.evaluate(async c => {
    const proto = (window as any).proto;
    await proto.setup(c);
    proto.start();
  }, s.config);
  await wait(500);
  if (s.body) {
    await s.body(p);
  }
  await wait((s.seconds ?? 2) * 1000);
  results[s.name] = await p.evaluate(() => (window as any).proto.stats());
  console.error(s.name, JSON.stringify(results[s.name]));
  await p.close();
}
console.log(JSON.stringify({ headless, results }, null, 2));
await browser.close();
server.stop();
