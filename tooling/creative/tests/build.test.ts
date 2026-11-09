import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  BASE_BUDGET_BYTES,
  baseFilePath,
  MUSIC_BASE_VERSION,
} from '../src/base-projects';
import { EXAMPLE_BUDGET_BYTES, EXAMPLE_PROJECTS } from '../src/examples';
import { KIT_SOUND_KEYS, renderKitSound } from '../src/kits/kits';
import { soundKey } from '../src/sounds';
import { parseMiniNotation } from '../src/mini-notation';
import { patternTexts } from '../src/pattern-checks';
import { readProjectFile } from '../src/project-file';
import { readZip } from '../src/zip';
import type { AddOnModule } from '../src/add-ons/api';
import { addOnChunk } from '../src/add-ons/catalogue';
import { COUNTER_ADD_ON, COUNTER_ENTRY } from './fixtures/counter-add-on';
import {
  build,
  dist,
  examplePrecacheFiles,
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
  for (const entry of [...precacheFiles, ...examplePrecacheFiles]) {
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
  expect(worker).toContain('onDemand: ["./projects/", "./add-ons/"]');
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
        if (KIT_SOUND_KEYS.includes(soundKey(word.value))) {
          played.add(soundKey(word.value));
        }
      }
    }
  }
  expect(played.size).toBeGreaterThan(0);
  for (const key of played) {
    const asset = project.assets.find(a => a.name === key);
    expect(asset, key).toBeDefined();
    expect(assets.get(asset!.hash), key).toEqual(renderKitSound(key));
  }
}, 60_000);

// Music's content at each version. Changing what Music holds without
// bumping MUSIC_BASE_VERSION fails here; bump both together. The file
// format's number is left out, so a format change alone keeps the version.
const MUSIC_FINGERPRINTS: Record<number, string> = {
  1: 'baec8a15f77e0622',
  // The synth moved into the Instruments Add-on (#1901).
  2: 'a926e5ae965e9fc8',
  // Music lists the controls Add-on, which Tools then offers (#2025).
  3: 'a5db6a146d357362',
  // Music performed when played (#2028), until ADR 0174.
  4: 'f3964152ed124aba',
  // Its starter Script loops from openScript, so Punch In keeps it (#2042).
  5: 'e78a6130985b087b',
  // Play browses every Project, so Music no longer sets `play` (ADR 0174).
  6: 'cbc56ee0328ae3ba',
  // Music lists the Piano Roll Add-on (#2181).
  7: 'c3b565d074336552',
  // The Piano Roll edits patterns from version 1.1.0 (#2182).
  8: 'c223cfd4d9498228',
  // The Piano Roll adds and removes Chord notes from 1.2.0 (#2187).
  9: 'd4620f60898ebcac',
  // The Piano Roll fills its window as it resizes, from 1.3.0.
  10: '259a8840f98d8d70',
};

test('the Music Base Project carries every kit sound, fetched on demand (ADR 0161)', async () => {
  await build({ minify: false });
  const path = resolve(dist, baseFilePath('music'));
  expect(statSync(path).size).toBeLessThanOrEqual(BASE_BUDGET_BYTES);
  const worker = readFileSync(resolve(dist, 'sw.js'), 'utf8');
  expect(worker).not.toContain(baseFilePath('music'));
  const { assets, project } = await readProjectFile(readFileSync(path));
  expect(project.base).toEqual({ name: 'music', version: MUSIC_BASE_VERSION });
  expect(project.assets.map(a => a.name).sort()).toEqual(
    [...KIT_SOUND_KEYS].sort(),
  );
  for (const key of KIT_SOUND_KEYS) {
    const asset = project.assets.find(a => a.name === key)!;
    expect(assets.get(asset.hash), key).toEqual(renderKitSound(key));
  }
  // The file's own JSON, so Add-ons registered by other tests, which fill
  // in their kinds' defaults on reading, don't change it.
  const saved = JSON.parse(
    new TextDecoder().decode(
      (await readZip(readFileSync(path))).get('project.json')!,
    ),
  ) as Record<string, unknown>;
  const { format: _format, ...content } = saved;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex')
    .slice(0, 16);
  expect(fingerprint).toBe(MUSIC_FINGERPRINTS[MUSIC_BASE_VERSION]!);
}, 60_000);

test('the build writes no kit sounds outside Project files (ADR 0161)', async () => {
  await build({ minify: false });
  expect(existsSync(resolve(dist, 'kits'))).toBe(false);
  const wavs = readdirSync(dist, { recursive: true })
    .map(String)
    .filter(path => path.endsWith('.wav'));
  expect(wavs).toEqual([]);
  const worker = readFileSync(resolve(dist, 'sw.js'), 'utf8');
  expect(worker).not.toContain('.wav');
}, 60_000);

test('each built-in Add-on is its own chunk, fetched on demand and imported whole (#1901)', async () => {
  const entry = COUNTER_ENTRY;
  await build({
    minify: true,
    addOns: [
      { entry, source: resolve(import.meta.dir, 'fixtures/counter-add-on.ts') },
    ],
  });
  const chunk = resolve(dist, addOnChunk(entry));
  expect(existsSync(chunk)).toBe(true);
  const worker = readFileSync(resolve(dist, 'sw.js'), 'utf8');
  expect(worker).not.toContain(addOnChunk(entry));
  expect(worker).toContain('./add-ons/');
  // It brings no Preact of its own; Folio hands it one.
  expect(readFileSync(chunk, 'utf8')).not.toContain('__H');
  const module = (await import(chunk)) as { default: AddOnModule };
  expect(module.default).toMatchObject({
    id: COUNTER_ADD_ON,
    version: '1.1.0',
  });
}, 60_000);
