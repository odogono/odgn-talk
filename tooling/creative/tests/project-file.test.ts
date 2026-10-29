import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BUTTON_STYLES,
  createElement,
  createProject,
  type ButtonElement,
  type TextElement,
} from '../src/model';
import {
  migrateProjectJson,
  PROJECT_MIMETYPE,
  ProjectFileError,
  readProjectFile,
  serializeProject,
  sha256Hex,
  validateProjectJson,
  writeProjectFile,
} from '../src/project-file';
import { readZip, writeZip } from '../src/zip';

const encode = (text: string) => new TextEncoder().encode(text);

/** A Project using every Element kind, Scripts at every level and assets. */
const sampleProject = async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const mp3 = encode('fake mp3 frames');
  const project = createProject('The Cellar Mystery');
  project.script = 'on startPlay\n  put 0 into clues\nend startPlay\n';
  const cellar = project.pages[0]!;
  cellar.name = 'cellar';
  cellar.height = 900;
  cellar.background = '#101018';
  cellar.script = 'on openPage\nend openPage\n';

  const note = createElement('text', 'verdict') as TextElement;
  note.richText = [
    {
      runs: [
        { text: 'It was ' },
        { text: 'you', bold: true, italic: true, color: '#ff0000' },
        { text: ' all along.', underline: true },
      ],
    },
    { runs: [{ text: 'Sign here:' }] },
  ];
  note.editable = true;
  note.script = 'on textChanged\nend textChanged\n';
  const lamp = createElement('image', 'lamp');
  if (lamp.kind === 'image') {
    lamp.image = 'lampPng';
  }
  const button = createElement('button', 'climbButton') as ButtonElement;
  button.label = 'Climb the stairs →';
  button.script =
    'on click {button: 0}\n  tell pages to show cellar\nend click\n';
  cellar.elements.push(
    note,
    lamp,
    button,
    createElement('rectangle', 'door'),
    createElement('ellipse', 'moon'),
    createElement('line', 'crack'),
  );
  project.assets.push(
    {
      name: 'lampPng',
      hash: await sha256Hex(png),
      mediaType: 'image/png',
      size: png.length,
      fileName: 'lamp.png',
    },
    {
      // A second name for the same bytes: stored once in the file.
      name: 'lampCopy',
      hash: await sha256Hex(png),
      mediaType: 'image/png',
      size: png.length,
      fileName: 'lamp.png',
    },
    {
      name: 'waves',
      hash: await sha256Hex(mp3),
      mediaType: 'audio/mpeg',
      size: mp3.length,
      fileName: 'waves.mp3',
    },
  );
  const assetBytes = new Map<string, Uint8Array>([
    [await sha256Hex(png), png],
    [await sha256Hex(mp3), mp3],
  ]);
  return { project, assetBytes, png, mp3 };
};

test('writing a Project and reading it back gives an equal Project', async () => {
  const { project, assetBytes, png } = await sampleProject();
  const file = await writeProjectFile(project, assetBytes);
  const read = await readProjectFile(file);
  expect(read.project).toEqual(project);
  expect(read.missingAssets).toEqual([]);
  expect([...read.assets.get([...assetBytes.keys()][0]!)!]).toEqual([...png]);
  // Two names share one hash, so the bytes are stored once.
  const entries = await readZip(file);
  expect([...entries.keys()].filter(n => n.startsWith('assets/'))).toHaveLength(
    2,
  );
  expect([...entries.keys()][0]).toBe('mimetype');
  expect(new TextDecoder().decode(entries.get('mimetype')!)).toBe(
    PROJECT_MIMETYPE,
  );
  const json = JSON.parse(
    new TextDecoder().decode(entries.get('project.json')!),
  );
  expect(json.format).toBe(5);
  expect(json.pages[0].elements.map((e: { kind: string }) => e.kind)).toEqual([
    'text',
    'image',
    'button',
    'rectangle',
    'ellipse',
    'line',
  ]);
});

test('a zip written by another tool, reordered and deflated, reads correctly', async () => {
  // tests/fixtures/foreign-project.zip was written by Python's zipfile
  // with every entry deflated and `mimetype` last.
  const bytes = new Uint8Array(
    readFileSync(resolve(import.meta.dir, 'fixtures/foreign-project.zip')),
  );
  const { project, assets, missingAssets } = await readProjectFile(bytes);
  expect(project.name).toBe('Foreign');
  expect(project.pages[0]!.elements.map(e => e.name)).toEqual([
    'verdict',
    'lamp',
  ]);
  expect(missingAssets).toEqual([]);
  expect(assets.size).toBe(1);
});

const fileWithJson = async (json: unknown) =>
  writeZip([
    { name: 'mimetype', data: encode(PROJECT_MIMETYPE) },
    {
      name: 'project.json',
      data: encode(typeof json === 'string' ? json : JSON.stringify(json)),
      method: 8,
    },
  ]);

test('button styles and typography survive a Project file round trip', async () => {
  const project = createProject('Buttons');
  for (const style of BUTTON_STYLES) {
    const button = createElement('button', style);
    Object.assign(button, { style, font: 'Georgia, serif', textSize: 12.5 });
    project.pages[0]!.elements.push(button);
  }
  const { project: loaded } = await readProjectFile(
    await writeProjectFile(project, new Map()),
  );
  expect(loaded).toEqual(project);
});

for (const format of [1, 2]) {
  test(`older format-${format} buttons keep their appearance in files and storage`, async () => {
    const project = createProject('Old buttons');
    project.pages[0]!.elements.push(createElement('button', 'go'));
    const json = serializeProject(project) as {
      format: number;
      pages: { elements: Record<string, unknown>[] }[];
    };
    json.format = format;
    const button = json.pages[0]!.elements[0]!;
    for (const field of ['font', 'textSize', 'style']) {
      delete button[field];
    }
    expect(validateProjectJson(json)).toEqual({ project });
    expect(button).not.toHaveProperty('style');
    expect((await readProjectFile(await fileWithJson(json))).project).toEqual(
      project,
    );
  });
}

test('invalid button typography and styles report their property path', () => {
  const project = createProject('Invalid buttons');
  project.pages[0]!.elements.push(createElement('button', 'go'));
  for (const [field, values] of Object.entries({
    font: [null, 42],
    textSize: [0, -1, Infinity, Number.NaN, null, '18'],
    style: ['none', '', 'Rounded', null, 42],
  })) {
    for (const value of values) {
      const json = serializeProject(project) as {
        pages: { elements: Record<string, unknown>[] }[];
      };
      json.pages[0]!.elements[0]![field] = value;
      expect(validateProjectJson(json)).toMatchObject({
        issues: [{ path: `pages[0].elements[0].${field}` }],
      });
    }
  }
});

for (const kind of ['rectangle', 'ellipse'] as const) {
  test(`${kind} border thickness survives a Project file round trip, including zero`, async () => {
    const project = createProject('Borders');
    for (const thickness of [0, 1, 5.5]) {
      const element = createElement(
        kind,
        `shape${project.pages[0]!.elements.length}`,
      );
      Object.assign(element, { thickness });
      project.pages[0]!.elements.push(element);
    }
    const { project: loaded } = await readProjectFile(
      await writeProjectFile(project, new Map()),
    );
    expect(loaded).toEqual(project);
  });

  test(`older ${kind} borders default to 2px without changing the input`, async () => {
    const project = createProject('Old borders');
    project.pages[0]!.elements.push(createElement(kind, 'shape'));
    const json = serializeProject(project) as {
      pages: { elements: Record<string, unknown>[] }[];
    };
    delete json.pages[0]!.elements[0]!.thickness;
    // Browser storage uses this same validation entry point.
    expect(validateProjectJson(json)).toEqual({ project });
    expect(json.pages[0]!.elements[0]).not.toHaveProperty('thickness');
    expect((await readProjectFile(await fileWithJson(json))).project).toEqual(
      project,
    );
  });

  test(`${kind} border thickness rejects negative and non-finite numbers and wrong types`, () => {
    const project = createProject('Invalid borders');
    project.pages[0]!.elements.push(createElement(kind, 'shape'));
    for (const thickness of [-1, Infinity, Number.NaN, null, '2']) {
      const json = serializeProject(project) as {
        pages: { elements: Record<string, unknown>[] }[];
      };
      json.pages[0]!.elements[0]!.thickness = thickness;
      expect(validateProjectJson(json)).toMatchObject({
        issues: [{ path: 'pages[0].elements[0].thickness' }],
      });
    }
  });
}

test('a newer format is refused with a clear error', async () => {
  const { project } = await sampleProject();
  const file = await fileWithJson({ ...serializeProject(project), format: 99 });
  await expect(readProjectFile(file)).rejects.toThrow(
    'newer version of the app (format 99; this app reads up to 5)',
  );
});

test('damaged JSON reports the path of what is wrong', async () => {
  const { project } = await sampleProject();
  const json = serializeProject(project) as {
    pages: { elements: Record<string, unknown>[] }[];
  };
  json.pages[0]!.elements[2]!.left = 'near the door';
  json.pages[0]!.elements[0]!.name = 'not an identifier';
  const error = await readProjectFile(await fileWithJson(json)).catch(
    (error_: unknown) => error_,
  );
  expect(error).toBeInstanceOf(ProjectFileError);
  const issues = (error as ProjectFileError).issues!;
  expect(issues.map(i => i.path)).toContain('pages[0].elements[2].left');
  expect(issues.map(i => i.path)).toContain('pages[0].elements[0].name');
  expect((error as Error).message).toContain('damaged at');
});

test('an unknown paragraph alignment is damage', async () => {
  const project = createProject('Aligned');
  const text = createElement('text', 'note');
  project.pages[0]!.elements.push(text);
  const json = serializeProject(project) as {
    pages: { elements: { richText: Record<string, unknown>[] }[] }[];
  };
  json.pages[0]!.elements[0]!.richText[0]!.align = 'middle';
  const error = await readProjectFile(await fileWithJson(json)).catch(
    (error_: unknown) => error_,
  );
  expect((error as ProjectFileError).issues!.map(i => i.path)).toEqual([
    'pages[0].elements[0].richText[0].align',
  ]);
});

test('Page alignment survives a round trip and rejects unknown values', async () => {
  const project = createProject('Placed');
  project.pages[0]!.alignX = 'right';
  project.pages[0]!.alignY = 'top';
  const read = await readProjectFile(
    await writeProjectFile(project, new Map()),
  );
  expect(read.project.pages[0]).toMatchObject({
    alignX: 'right',
    alignY: 'top',
  });
  const json = serializeProject(project) as {
    pages: Record<string, unknown>[];
  };
  json.pages[0]!.alignY = 'middle';
  const error = await readProjectFile(await fileWithJson(json)).catch(
    (error_: unknown) => error_,
  );
  expect((error as ProjectFileError).issues!.map(i => i.path)).toEqual([
    'pages[0].alignY',
  ]);
});

test('invalid JSON and a missing project.json are errors, never a half-read Project', async () => {
  await expect(readProjectFile(await fileWithJson('{oops'))).rejects.toThrow(
    'project.json: not valid JSON',
  );
  const bare = await writeZip([
    { name: 'mimetype', data: encode(PROJECT_MIMETYPE) },
  ]);
  await expect(readProjectFile(bare)).rejects.toThrow('no project.json');
});

test('a corrupt zip and a CRC mismatch are errors', async () => {
  const { project, assetBytes } = await sampleProject();
  const file = await writeProjectFile(project, assetBytes);
  await expect(readProjectFile(file.subarray(0, 40))).rejects.toThrow(
    ProjectFileError,
  );
  const damaged = new Uint8Array(file);
  // Damage the stored mimetype bytes, which follow their local header.
  const at = new TextDecoder().decode(damaged).indexOf('application/vnd');
  damaged[at] = damaged[at]! ^ 0xff;
  await expect(readProjectFile(damaged)).rejects.toThrow('CRC-32');
});

test('duplicate Element names on a Page are reported by path', async () => {
  const { project } = await sampleProject();
  const json = serializeProject(project) as {
    pages: { elements: Record<string, unknown>[] }[];
  };
  json.pages[0]!.elements[1]!.name = 'verdict';
  const error = await readProjectFile(await fileWithJson(json)).catch(
    (error_: unknown) => error_,
  );
  expect((error as ProjectFileError).issues?.map(i => i.path)).toContain(
    'pages[0].elements[1].name',
  );
});

test('a missing asset file opens as missing, not as an error', async () => {
  const { project } = await sampleProject();
  const read = await readProjectFile(
    await fileWithJson(serializeProject(project)),
  );
  expect(read.project).toEqual(project);
  expect(read.missingAssets.map(a => a.name)).toEqual([
    'lampPng',
    'lampCopy',
    'waves',
  ]);
  expect(read.assets.size).toBe(0);
});

test('writing refuses asset bytes that do not match the table', async () => {
  const { project } = await sampleProject();
  await expect(writeProjectFile(project, new Map())).rejects.toThrow(
    'has no bytes',
  );
  const wrong = new Map([[project.assets[0]!.hash, new Uint8Array([9])]]);
  await expect(writeProjectFile(project, wrong)).rejects.toThrow(
    'do not match',
  );
});

test('older formats migrate one step at a time', () => {
  const steps: string[] = [];
  const migrated = migrateProjectJson(
    { format: 1, name: 'Old' },
    {
      1: d => (steps.push('1→2'), { ...d, two: true }),
      2: d => (steps.push('2→3'), { ...d, three: true }),
    },
    3,
  );
  expect(steps).toEqual(['1→2', '2→3']);
  expect(migrated).toEqual({ format: 3, name: 'Old', two: true, three: true });
  expect(() => migrateProjectJson({ format: 4 }, {}, 3)).toThrow(
    'newer version',
  );
  expect(() => migrateProjectJson({ name: 'x' })).toThrow('format');
});

test('session ids leave Project JSON and portable file bytes unchanged', async () => {
  const { StackEditor } = await import('../src/editing');
  const project = createProject('Portable');
  project.pages[0]!.elements.push(createElement('text', 'text1'));
  const editor = new StackEditor(project);
  expect(editor.page.id).toBeDefined();
  expect(editor.page.elements[0]!.id).toBeDefined();
  expect(JSON.stringify(serializeProject(editor.project))).toBe(
    JSON.stringify(serializeProject(project)),
  );
  expect(await writeProjectFile(editor.project, new Map())).toEqual(
    await writeProjectFile(project, new Map()),
  );
});

test('Test Scripts save with the Project, and older files get none', async () => {
  const project = createProject('Tested');
  project.testScripts.push({
    id: 7,
    name: 'rules.test',
    source: 'on testNothing\nend testNothing\n',
  });
  const read = await readProjectFile(
    await writeProjectFile(project, new Map()),
  );
  expect(read.project.testScripts).toEqual([
    { name: 'rules.test', source: 'on testNothing\nend testNothing\n' },
  ]);
  const { testScripts: _, ...old } = serializeProject(createProject('Old'));
  expect(migrateProjectJson({ ...old, format: 3 }).testScripts).toEqual([]);
});

// A Project's JSON with Test Scripts of these names.
const json = (...names: string[]) =>
  validateProjectJson({
    ...serializeProject(createProject('Tested')),
    testScripts: names.map(name => ({ name, source: '' })),
  });

test('a Test Script needs an identifier and then .test, once each', () => {
  expect(json('rules.test')).not.toHaveProperty('issues');
  for (const name of ['rules', 'two words.test', 'if.test', '.test']) {
    expect(json(name)).toEqual({
      issues: [
        {
          path: 'testScripts[0].name',
          message:
            'Use a NorthTalk identifier and then .test for the Test Script name.',
        },
      ],
    });
  }
  expect(json('a.test', 'a.test')).toHaveProperty('issues');
});
