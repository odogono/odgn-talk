import { expect, test } from 'bun:test';
import {
  ImageAssets,
  importImage,
  IMAGE_MAX_SIZE,
  IMAGE_WARNING_SIZE,
  projectForExport,
} from '../src/images';
import { StackEditor } from '../src/editing';
import { createElement, createProject } from '../src/model';
import { readProjectFile, writeProjectFile } from '../src/project-file';
import { readZip } from '../src/zip';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const decode = async () => {};

test('sniffs bytes and requires a successful decode, regardless of name and MIME', async () => {
  let mediaType = '';
  const image = await importImage(
    new File([png], 'wrong.mp3', { type: 'audio/mpeg' }),
    async blob => {
      mediaType = blob.type;
    },
  );
  expect(mediaType).toBe('image/png');
  expect(image.asset.mediaType).toBe('image/png');
  await expect(
    importImage(new File([png], 'broken.png'), async () => {
      throw new DOMException('broken data', 'EncodingError');
    }),
  ).rejects.toThrow('could not be decoded (EncodingError: broken data)');
  await expect(
    importImage(new File(['not an image'], 'fake.png'), decode),
  ).rejects.toThrow('unsupported image type');
});

test('recognizes all supported image containers, warning for AVIF', async () => {
  const examples = [
    [new Uint8Array([255, 216, 255]), 'image/jpeg'],
    [new TextEncoder().encode('GIF89a'), 'image/gif'],
    [new TextEncoder().encode('RIFF0000WEBP'), 'image/webp'],
    [
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      ),
      'image/svg+xml',
    ],
    [
      new Uint8Array([
        0,
        0,
        0,
        20,
        ...new TextEncoder().encode('ftypavif0000avif'),
      ]),
      'image/avif',
    ],
  ] as const;
  for (const [bytes, type] of examples) {
    const image = await importImage(new File([bytes], 'image.bin'), decode);
    expect(image.asset.mediaType).toBe(type);
    expect(image.warnings.length).toBe(type === 'image/avif' ? 1 : 0);
  }
});

test('warns only above 10 MB and refuses only above 50 MB before reading or decoding', async () => {
  for (const [size, warnings] of [
    [IMAGE_WARNING_SIZE, 0],
    [IMAGE_WARNING_SIZE + 1, 1],
    [IMAGE_MAX_SIZE, 1],
  ]) {
    const bytes = new Uint8Array(size!);
    bytes.set(png);
    expect(
      (await importImage(new File([bytes], 'large.png'), decode)).warnings,
    ).toHaveLength(warnings!);
  }
  let called = false;
  await expect(
    importImage(
      new File([new Uint8Array(IMAGE_MAX_SIZE + 1)], 'huge.png'),
      async () => {
        called = true;
      },
    ),
  ).rejects.toThrow('above 50 MB');
  expect(called).toBe(false);
});

test('equal content under different names has one hash, one cached copy and one zip entry', async () => {
  const a = await importImage(new File([png], 'a.png'), decode);
  const b = await importImage(new File([png], 'b.png'), decode);
  expect(a.asset.hash).toBe(b.asset.hash);
  const images = new ImageAssets();
  images.add(a);
  images.add(b);
  expect(images.bytes.size).toBe(1);
  const project = createProject('Pictures');
  project.assets.push(a.asset, b.asset);
  const entries = await readZip(await writeProjectFile(project, images.bytes));
  expect([...entries.keys()].filter(k => k.startsWith('assets/'))).toHaveLength(
    1,
  );
});

test('export drops unused assets without changing the editor and preserves missing references', async () => {
  const imported = await importImage(new File([png], 'a.png'), decode);
  const project = createProject('Pictures');
  project.assets.push(imported.asset, { ...imported.asset, name: 'unused' });
  const element = createElement('image', 'picture');
  if (element.kind !== 'image') {
    throw new Error('expected image');
  }
  element.image = imported.asset.name;
  project.pages[0]!.elements.push(element);
  const copy = projectForExport(project);
  expect(copy.assets).toHaveLength(1);
  expect(project.assets).toHaveLength(2);
  const loaded = await readProjectFile(
    await writeProjectFile(copy, new Map(), { allowMissing: true }),
  );
  expect(loaded.project).toEqual(copy);
  expect(loaded.missingAssets).toEqual([imported.asset]);
  await expect(writeProjectFile(copy, new Map())).rejects.toThrow('no bytes');
});

test('image insertion and replacement restore the entire model and selection through undo and redo', async () => {
  const image = await importImage(new File([png], 'first.png'), decode);
  const project = createProject('Images');
  const editor = new StackEditor(project);
  const before = structuredClone(project);
  editor.setImage(image.asset, undefined, { left: 12, top: 34 });
  const after = structuredClone(project);
  expect(editor.selection).toEqual(['image1']);
  editor.undo();
  expect(project).toEqual(before);
  expect(editor.selection).toEqual([]);
  editor.redo();
  expect(project).toEqual(after);
  expect(editor.selection).toEqual(['image1']);
  editor.setImage({ ...image.asset, hash: 'a'.repeat(64) }, 'image1');
  expect(project.assets.map(a => a.name)).toEqual(['first.png', 'first.png2']);
  editor.undo();
  expect(project).toEqual(after);
  editor.readOnly = true;
  editor.setImage(image.asset);
  expect(project).toEqual(after);
});
