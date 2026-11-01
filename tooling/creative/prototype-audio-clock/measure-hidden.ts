/* eslint-disable @typescript-eslint/no-explicit-any, no-console -- throwaway prototype (#1888) */
// PROTOTYPE (#1888): `bun tooling/creative/prototype-audio-clock/measure-hidden.ts`
// Playwright keeps every page "visible", so this drives a plain Chromium over
// raw CDP: the prototype runs 40 s, and a second tab hides it from 10 s to 30 s.
import { chromium } from 'playwright';
import { reported, server } from './serve';

const port = 9339;
const proc = Bun.spawn([
  chromium.executablePath(),
  `--remote-debugging-port=${port}`,
  '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  `--user-data-dir=/tmp/proto1888-profile`,
  `${server.url.href}?auto=40&ticker=1`,
]);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
await wait(10_000);
const { webSocketDebuggerUrl } = await (
  await fetch(`http://127.0.0.1:${port}/json/version`)
).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));
let id = 0;
const call = (method: string, params = {}) =>
  ws.send(JSON.stringify({ id: ++id, method, params }));
call('Target.createTarget', { url: 'about:blank', background: false });
await wait(20_000);
call('Target.getTargets');
const targets: any = await new Promise(
  r =>
    (ws.onmessage = e => {
      const m = JSON.parse(String(e.data));
      if (m.result?.targetInfos) {
        r(m.result.targetInfos);
      }
    }),
);
const blank = targets.find((t: any) => t.url === 'about:blank');
call('Target.closeTarget', { targetId: blank.targetId });
const report = await reported();
console.log(
  JSON.stringify({ results: { 'hidden tab 10-30s': report } }, null, 2),
);
proc.kill();
server.stop();
