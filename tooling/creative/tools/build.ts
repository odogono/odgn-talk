#!/usr/bin/env bun
// Build the creative tool into a static `dist/`: the page script, the LSP
// and Play workers, the service worker, the page, its styles, the install manifest
// and its icons. Any static host can serve the result. The service
// worker is stamped with the list of shell files to precache and a
// version hashed from their contents, so a rebuild with no shell change
// keeps the installed worker, and a changed shell offers an update. Each
// Example Project gets a `.folio` file and a copy of the page at
// `<slug>/`, so `/folio/<slug>` is a static file too (ADR 0141); the
// service worker keeps a `.folio` file when first fetched (ADR 0161).
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
  EXAMPLE_META,
  EXAMPLE_PROJECTS,
  exampleFilePath,
} from '../src/examples';
import { baseFilePath, createMusicBase } from '../src/base-projects';
import { writeProjectFile } from '../src/project-file';
import type { AddOnModule } from '../src/add-ons/api';
import { AddOnLoader } from '../src/add-ons/loader';
import {
  addOnChunk,
  addOnWorklet,
  BUILT_IN_ADD_ONS,
  type CatalogueEntry,
} from '../src/add-ons/catalogue';
import { iconPng, iconSvg } from './icons';

const root = resolve(import.meta.dir, '..');
export const dist = resolve(root, 'dist');

/**
 * The app shell the service worker precaches for offline use (#823). The
 * page is `./`, not `./index.html`, because hosts such as Cloudflare
 * redirect `index.html` to its directory, and a browser refuses a cached
 * redirect as a navigation's response (#1662).
 */
export const precacheFiles = [
  './',
  './style.css',
  './main.js',
  './lsp.worker.js',
  './play.worker.js',
  './instruments.worklet.js',
  './folio.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './maskable-512.png',
  './apple-touch-icon.png',
  './UNICODE-LICENSE.txt',
];

/**
 * Each Example Project's page, precached with the shell. Its `.folio` file
 * carries its own sounds, so it is fetched on demand instead (ADR 0161).
 */
export const examplePrecacheFiles = EXAMPLE_PROJECTS.map(
  example => `./${example.slug}/`,
);

/**
 * URL prefixes the service worker keeps when first fetched: Base and
 * Example Projects (ADR 0161) and built-in Add-ons (ADR 0162).
 */
export const onDemandPrefixes = ['./projects/', './add-ons/'];

/** A built-in Add-on to build: its catalogue entry and its source. */
export type AddOnSource = { entry: CatalogueEntry; source: string };

const builtInAddOns = (): AddOnSource[] =>
  BUILT_IN_ADD_ONS.map(entry => ({
    entry,
    source: resolve(root, 'src/add-ons', entry.slug, 'index.ts'),
  }));

/** Builds each Add-on as its own chunk, fetched on demand (#1901). */
const buildAddOns = async (
  addOns: readonly AddOnSource[],
  minify: boolean,
): Promise<void> => {
  for (const { entry, source } of addOns) {
    const result = await Bun.build({
      entrypoints: [source],
      outdir: dist,
      target: 'browser',
      format: 'esm',
      naming: addOnChunk(entry),
      minify,
      sourcemap: 'linked',
    });
    if (!result.success) {
      throw new AggregateError(result.logs, `Add-on ${entry.id} build failed`);
    }
    if (entry.worklet) {
      const worklet = await Bun.build({
        entrypoints: [resolve(source, '..', 'worklet.ts')],
        outdir: dist,
        target: 'browser',
        format: 'esm',
        naming: addOnWorklet(entry),
        minify,
        sourcemap: 'linked',
      });
      if (!worklet.success) {
        throw new AggregateError(
          worklet.logs,
          `Add-on ${entry.id} worklet build failed`,
        );
      }
    }
  }
};

/** The file in `dist/` behind a precached URL. */
export const shellFile = (entry: string): string =>
  entry.endsWith('/') ? `${entry}index.html` : entry;

/**
 * Folio's page as served from `<slug>/`: one level down, so its relative
 * URLs climb a level, and naming the Example Project to open.
 */
export const examplePage = (page: string, slug: string): string =>
  page
    .replaceAll('="./', '="../')
    .replace(
      '<meta charset="utf-8" />',
      `<meta charset="utf-8" />\n    <meta name="${EXAMPLE_META}" content="${slug}" />`,
    );

const writeExamples = async (): Promise<void> => {
  // Built-in Add-ons' kinds write every parameter, so the files don't
  // depend on what was loaded when they were built (#1901).
  for (const problem of await new AddOnLoader({
    importer: async entry =>
      (
        (await import(
          resolve(root, 'src/add-ons', entry.slug, 'index.ts')
        )) as {
          default: AddOnModule;
        }
      ).default,
  }).load(BUILT_IN_ADD_ONS)) {
    throw new Error(`Add-on ${problem.id}: ${problem.message}`);
  }
  const page = readFileSync(resolve(dist, 'index.html'), 'utf8');
  mkdirSync(resolve(dist, 'projects'), { recursive: true });
  const music = await createMusicBase();
  writeFileSync(
    resolve(dist, baseFilePath('music')),
    await writeProjectFile(music.project, music.assets),
  );
  for (const example of EXAMPLE_PROJECTS) {
    const { assets, project } = await example.create();
    writeFileSync(
      resolve(dist, exampleFilePath(example.slug)),
      await writeProjectFile(project, assets),
    );
    mkdirSync(resolve(dist, example.slug), { recursive: true });
    writeFileSync(
      resolve(dist, example.slug, 'index.html'),
      examplePage(page, example.slug),
    );
  }
};

export const build = async ({
  minify = true,
  addOns = builtInAddOns(),
}: {
  addOns?: readonly AddOnSource[];
  minify?: boolean;
} = {}): Promise<void> => {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const result = await Bun.build({
    entrypoints: [
      resolve(root, 'src/main.ts'),
      resolve(root, '../editor/src/lsp.worker.ts'),
      resolve(root, 'src/play.worker.ts'),
      resolve(root, 'src/instruments/instruments.worklet.ts'),
    ],
    outdir: dist,
    target: 'browser',
    format: 'esm',
    naming: '[name].[ext]',
    minify,
    sourcemap: 'linked',
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'Creative tool build failed');
  }
  for (const file of ['index.html', 'style.css', 'folio.webmanifest']) {
    copyFileSync(resolve(root, 'static', file), resolve(dist, file));
  }
  copyFileSync(
    resolve(root, '../../impl/ts/src/generated/UNICODE-LICENSE.txt'),
    resolve(dist, 'UNICODE-LICENSE.txt'),
  );
  writeFileSync(resolve(dist, 'icon.svg'), iconSvg);
  writeFileSync(resolve(dist, 'icon-192.png'), iconPng(192));
  writeFileSync(resolve(dist, 'icon-512.png'), iconPng(512));
  writeFileSync(
    resolve(dist, 'maskable-512.png'),
    iconPng(512, { maskable: true }),
  );
  writeFileSync(resolve(dist, 'apple-touch-icon.png'), iconPng(180));
  await writeExamples();
  await buildAddOns(addOns, minify);

  const precache = [...precacheFiles, ...examplePrecacheFiles];
  const hash = createHash('sha256');
  for (const entry of precache) {
    hash.update(entry);
    hash.update(readFileSync(resolve(dist, shellFile(entry))));
  }
  const version = hash.digest('hex').slice(0, 16);
  const worker = await Bun.build({
    entrypoints: [resolve(root, 'src/sw.ts')],
    outdir: dist,
    target: 'browser',
    format: 'iife',
    naming: '[name].[ext]',
    minify,
    sourcemap: 'linked',
    define: {
      __FOLIO_ON_DEMAND__: JSON.stringify(onDemandPrefixes),
      __FOLIO_PRECACHE__: JSON.stringify(precache),
      __FOLIO_VERSION__: JSON.stringify(version),
    },
  });
  if (!worker.success) {
    throw new AggregateError(worker.logs, 'Service worker build failed');
  }
};

if (import.meta.main) {
  await build();
  console.log(`Built Folio in ${dist}`);
}
