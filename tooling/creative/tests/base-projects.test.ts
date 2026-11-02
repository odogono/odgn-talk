// Starting a new Project from a Base Project (ADR 0161, #1956).
import { expect, test } from 'bun:test';
import {
  BLANK_BASE_VERSION,
  createFromBase,
  createMusicBase,
  MUSIC_BASE_VERSION,
} from '../src/base-projects';
import { writeProjectFile } from '../src/project-file';

const refuse = (() =>
  Promise.reject(new Error('fetched'))) as unknown as typeof fetch;

test('Blank needs no fetch and records its base', async () => {
  const { assets, project } = await createFromBase('blank', 'Untitled', refuse);
  expect(project.name).toBe('Untitled');
  expect(project.base).toEqual({ name: 'blank', version: BLANK_BASE_VERSION });
  expect(project.assets).toEqual([]);
  expect(assets.size).toBe(0);
});

test('Music is fetched and copied with its sounds under a new name', async () => {
  const music = await createMusicBase();
  const file = await writeProjectFile(music.project, music.assets);
  const asked: string[] = [];
  const fetchFn = ((url: string) => {
    asked.push(url);
    return Promise.resolve(new Response(file as Uint8Array<ArrayBuffer>));
  }) as unknown as typeof fetch;
  const { assets, project } = await createFromBase(
    'music',
    'Untitled',
    fetchFn,
  );
  expect(asked).toEqual(['projects/music.folio']);
  expect(project.name).toBe('Untitled');
  expect(project.base).toEqual({ name: 'music', version: MUSIC_BASE_VERSION });
  expect(project.assets.some(a => a.name === 'bd')).toBe(true);
  expect(assets.size).toBe(music.assets.size);
});

test('Music never fetched online says so when offline', async () => {
  await expect(
    createFromBase('music', 'Untitled', (() =>
      Promise.resolve(
        new Response('', { status: 503 }),
      )) as unknown as typeof fetch),
  ).rejects.toThrow('Open it once while online');
});
