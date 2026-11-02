import { expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXAMPLE_BUDGET_BYTES, EXAMPLE_PROJECTS } from '../src/examples';
import {
  KIT_BUDGET_BYTES,
  KIT_FILES,
  KIT_SAMPLE_NAMES,
  kitSampleKey,
  renderKitFiles,
} from '../src/kits/kits';
import { parseMiniNotation } from '../src/mini-notation';
import { patternTexts } from '../src/pattern-checks';
import { readProjectFile } from '../src/project-file';
import {
  build,
  dist,
  examplePrecacheFiles,
  KIT_NOTICE,
  kitPrecacheFiles,
  precacheFiles,
  shellFile,
} from '../tools/build';

test('the build writes the page, its script and the LSP worker', async () => {
  await build({ minify: false });
  for (const file of [
    'index.html',
    'style.css',
    'main.js',
    'lsp.worker.js',
    'UNICODE-LICENSE.txt',
  ]) {
    expect(existsSync(resolve(dist, file))).toBe(true);
  }
}, 60_000);

test('the build writes everything offline use and installation need', async () => {
  await build({ minify: false });
  for (const file of [
    'sw.js',
    'folio.webmanifest',
    'icon.svg',
    'icon-192.png',
    'icon-512.png',
    'maskable-512.png',
    'apple-touch-icon.png',
  ]) {
    expect(existsSync(resolve(dist, file)), file).toBe(true);
  }

  const manifest = JSON.parse(
    readFileSync(resolve(dist, 'folio.webmanifest'), 'utf8'),
  ) as {
    display: string;
    file_handlers: { accept: Record<string, string[]> }[];
    icons: { sizes: string; src: string }[];
    name: string;
    short_name: string;
    start_url: string;
  };
  // ADR 0087 settled these names for the manifest.
  expect(manifest.name).toBe('Folio, made with NorthTalk');
  expect(manifest.short_name).toBe('Folio');
  expect(manifest.start_url).toBe('.');
  expect(manifest.display).toBe('standalone');
  const iconSizes = manifest.icons.map(icon => icon.sizes);
  expect(iconSizes).toContain('192x192');
  expect(iconSizes).toContain('512x512');
  for (const icon of manifest.icons) {
    expect(existsSync(resolve(dist, icon.src)), icon.src).toBe(true);
  }
  // The installed app opens Project files from the operating system.
  expect(manifest.file_handlers).toHaveLength(1);
  expect(manifest.file_handlers[0]!.accept).toEqual({
    'application/vnd.odgn.northtalk-project+zip': ['.folio'],
  });

  const png = readFileSync(resolve(dist, 'icon-192.png'));
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  // The PNG header carries the icon's real dimensions.
  expect(png.readUInt32BE(16)).toBe(192);
  expect(png.readUInt32BE(20)).toBe(192);

  const worker = readFileSync(resolve(dist, 'sw.js'), 'utf8');
  expect(worker).not.toContain('__FOLIO_PRECACHE__');
  expect(worker).not.toContain('__FOLIO_VERSION__');
  // Every precached file exists, so installing the worker cannot fail
  // on a missing shell file.
  for (const entry of [
    ...precacheFiles,
    ...kitPrecacheFiles,
    ...examplePrecacheFiles,
  ]) {
    expect(existsSync(resolve(dist, shellFile(entry))), entry).toBe(true);
    expect(worker).toContain(JSON.stringify(entry));
  }
}, 60_000);

test('each Example Project has a static page and a .folio file', async () => {
  await build({ minify: false });
  const slugs = EXAMPLE_PROJECTS.map(example => example.slug);
  expect(new Set(slugs).size).toBe(slugs.length);
  for (const example of EXAMPLE_PROJECTS) {
    expect(example.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    const page = readFileSync(
      resolve(dist, example.slug, 'index.html'),
      'utf8',
    );
    // The page sits a level down, so nothing it loads may point at `./`.
    expect(page).not.toContain('="./');
    expect(page).toContain('src="../main.js"');
    expect(page).toContain(
      `<meta name="folio-example" content="${example.slug}" />`,
    );
    const loaded = await readProjectFile(
      readFileSync(resolve(dist, 'projects', `${example.slug}.folio`)),
    );
    expect(loaded.project.name).toBe(example.name);
    expect(loaded.missingAssets).toEqual([]);
  }
}, 60_000);

test('Example Projects are fetched on demand, never precached', async () => {
  await build({ minify: false });
  const worker = readFileSync(resolve(dist, 'sw.js'), 'utf8');
  for (const example of EXAMPLE_PROJECTS) {
    expect(worker).not.toContain(`projects/${example.slug}.folio`);
    const size = statSync(
      resolve(dist, 'projects', `${example.slug}.folio`),
    ).size;
    expect(size, example.slug).toBeLessThanOrEqual(EXAMPLE_BUDGET_BYTES);
  }
  expect(worker).toContain(JSON.stringify(['./projects/']));
}, 60_000);

test('First Sounds carries every kit sound its patterns play (ADR 0161)', async () => {
  await build({ minify: false });
  const { assets, project } = await readProjectFile(
    readFileSync(resolve(dist, 'projects', 'first-sounds.folio')),
  );
  const samplers = new Set(
    project.instruments.filter(i => i.kind === 'sampler').map(i => i.name),
  );
  const played = new Set<string>();
  for (const source of [project.script, ...project.pages.map(p => p.script)]) {
    for (const { on, text } of patternTexts(source ?? '')) {
      const parsed = parseMiniNotation(text);
      if (!parsed.ok || (on !== undefined && !samplers.has(on))) {
        continue;
      }
      for (const word of parsed.pattern.words()) {
        if (KIT_SAMPLE_NAMES.has(word.value.name)) {
          played.add(kitSampleKey(word.value.name, word.value.index));
        }
      }
    }
  }
  expect(played.size).toBeGreaterThan(0);
  const rendered = renderKitFiles();
  for (const key of played) {
    const asset = project.assets.find(a => a.name === key);
    expect(asset, key).toBeDefined();
    const path = KIT_FILES.find(file => file.key === key)!.path;
    expect(assets.get(asset!.hash), key).toEqual(rendered.get(path)!);
  }
}, 60_000);

test('the built-in kits are built, precached with their licence and within budget', async () => {
  await build({ minify: false });
  const worker = readFileSync(resolve(dist, 'sw.js'), 'utf8');
  let total = 0;
  for (const file of KIT_FILES) {
    expect(worker, file.path).toContain(JSON.stringify(`./${file.path}`));
    total += statSync(resolve(dist, file.path)).size;
  }
  expect(total).toBeLessThanOrEqual(KIT_BUDGET_BYTES);
  expect(worker).toContain(JSON.stringify(`./${KIT_NOTICE}`));
  expect(readFileSync(resolve(dist, KIT_NOTICE), 'utf8')).toContain(
    'Licence: CC0 1.0',
  );
}, 60_000);
