/* eslint-disable no-console -- throwaway prototype (#1888) */
// PROTOTYPE (#1888): `bun tooling/creative/prototype-audio-clock/serve.ts`
// builds and serves the prototype at http://127.0.0.1:3929/.
import { join } from 'node:path';
const here = import.meta.dir;
const dist = join(here, 'dist');
const r = await Bun.build({
  entrypoints: ['page.ts', 'worker.ts', 'worklet.ts'].map(f => join(here, f)),
  outdir: dist,
  target: 'browser',
  format: 'esm',
});
if (!r.success) {
  throw new AggregateError(r.logs);
}
await Bun.write(join(dist, 'index.html'), Bun.file(join(here, 'index.html')));
let onReport: (r: unknown) => void = () => {};
export const reported = () => new Promise(r => (onReport = r));
export const server = Bun.serve({
  port: Number(process.env.PORT ?? 3929),
  hostname: '127.0.0.1',
  fetch: async req => {
    const p = new URL(req.url).pathname;
    if (p === '/report') {
      onReport(await req.json());
      return new Response('ok');
    }
    return new Response(Bun.file(join(dist, p === '/' ? 'index.html' : p)));
  },
});
console.error(`PROTOTYPE at ${server.url}`);
