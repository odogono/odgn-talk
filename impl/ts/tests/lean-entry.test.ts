// `@northtalk/ts/lean` registers no stdlib Library, so a browser bundle carries
// only those its Host registers (#1856). The stdlib registry belongs to the
// process, and this test process has loaded the main entry, so each Host here
// runs bundled in a fresh process.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { stdlibSources } from '../src/generated/stdlib';

const src = resolve(import.meta.dir, '../src');
const directory = mkdtempSync(join(tmpdir(), 'northtalk-lean-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

// A Host registering no Library may not grow past this, gzipped at level 9,
// without a deliberate change here. It was 188,172 bytes when set, against
// 206,643 for the same Host on the main entry (#1856).
const leanBudget = 195_000;

// A line only that Library's source holds, which a minifier copies unchanged.
const markers = Object.fromEntries(
  Object.entries(stdlibSources).map(([name, source]) => [
    name,
    source
      .split('\n')
      .find(
        line =>
          /^[\w (),.-]{30,}$/.test(line) &&
          Object.entries(stdlibSources).every(
            ([other, s]) => other === name || !s.includes(line),
          ),
      )!,
  ]),
);

const host = (name: string, registers: readonly string[], body: string) => {
  const path = join(directory, `${name}.ts`);
  writeFileSync(
    path,
    [
      `import { createCore, LoadError, registerStdlib } from '${src}/lean';`,
      ...registers.map(
        l => `import { ${l} } from '${src}/generated/stdlib/${l}';`,
      ),
      registers.length ? `registerStdlib(${registers.join(', ')});` : '',
      'const core = createCore();',
      body,
    ].join('\n'),
  );
  return path;
};

const bundle = async (entry: string) => {
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    minify: true,
  });
  expect(built.success).toBe(true);
  return built.outputs[0]!.text();
};

const holds = (code: string) =>
  Object.keys(markers)
    .filter(name => code.includes(markers[name]!))
    .sort();

const load = (source: string) => `
const outcome = (() => {
  try {
    core.newGroup({ name: 'g' }).load({ name: 's', source: ${JSON.stringify(source)} });
    return 'loaded';
  } catch (e) {
    return e instanceof LoadError ? e.diagnostics.map(d => d.code).join() : String(e);
  }
})();
console.log(outcome);
`;

const run = async (entry: string) => {
  const out = join(directory, `${Bun.hash(entry)}.mjs`);
  writeFileSync(out, await bundle(entry));
  const p = Bun.spawnSync(['bun', out]);
  expect(p.stderr.toString()).toBe('');
  return p.stdout.toString().trim();
};

test('a Host registering no Library bundles none of their sources', async () => {
  const code = await bundle(host('none', [], 'console.log(core);'));
  expect(holds(code)).toEqual([]);
  expect(gzipSync(code, { level: 9 }).length).toBeLessThan(leanBudget);
});

test('a Library brings the stdlib Libraries it uses, and only those', async () => {
  const code = await bundle(host('json', ['json'], 'console.log(core);'));
  expect(holds(code)).toEqual(['json', 'text']);
});

test('a Script using an unregistered Library fails to load', async () => {
  const script =
    'use encodeJson from json\non go\n  return encodeJson([1])\nend go\n';
  expect(await run(host('missing', [], load(script)))).toBe(
    'unknown import,unknown name',
  );
  expect(await run(host('present', ['json'], load(script)))).toBe('loaded');
  // text came with json.
  expect(
    await run(
      host('carried', ['json'], load('use join from text\non go\nend go\n')),
    ),
  ).toBe('loaded');
});
