#!/usr/bin/env bun
// Serve the browser corpus page: the blessed Trace Cases and Session
// Transcripts that `corpus:run` runs by default, run on the TS Core in an
// actual browser. Open the printed URL; the page reports each case.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const corpus = resolve(root, '../../corpus');
const port = Number(process.env.PORT ?? 3928);

const casesUnder = (path: string): string[] => {
  const entries = readdirSync(path);
  if (entries.includes('case.toml')) {
    return [path];
  }
  return entries.sort().flatMap(name => {
    const child = resolve(path, name);
    return statSync(child).isDirectory() ? casesUnder(child) : [];
  });
};

type Setup = {
  kind: string;
  libraries?: { source: string }[];
  scripts?: { source: string }[];
};

// Each case the Bun runner runs by default, with every file it reads.
const cases = () =>
  casesUnder(corpus).flatMap(dir => {
    const setup = Bun.TOML.parse(
      readFileSync(resolve(dir, 'case.toml'), 'utf8'),
    ) as Setup;
    if (setup.kind !== 'trace' && setup.kind !== 'transcript') {
      return [];
    }
    const trace = readFileSync(resolve(dir, 'case.trace'), 'utf8');
    if (trace.includes('# Unblessed:')) {
      return [];
    }
    const paths = [
      'case.trace',
      ...(setup.kind === 'transcript' ? ['session.transcript'] : []),
      ...[...(setup.scripts ?? []), ...(setup.libraries ?? [])].map(
        s => s.source,
      ),
    ];
    return [
      {
        name: relative(corpus, dir),
        kind: setup.kind,
        setup,
        files: Object.fromEntries(
          paths.map(p => [p, readFileSync(resolve(dir, p), 'utf8')]),
        ),
      },
    ];
  });

const bundle = await Bun.build({
  entrypoints: [resolve(root, 'src/corpus-page.ts')],
  target: 'browser',
  format: 'esm',
});
if (!bundle.success) {
  throw new AggregateError(bundle.logs, 'Corpus page build failed');
}
const script = await bundle.outputs[0]!.text();

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') {
      return new Response(Bun.file(resolve(root, 'tests/corpus.html')), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (path === '/corpus-page.js') {
      return new Response(script, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    }
    if (path === '/cases.json') {
      return Response.json(cases());
    }
    return new Response('Not found', { status: 404 });
  },
});
console.log(`Browser corpus page: ${server.url}`);
