// Add-ons in the Project file and placeholders for their kinds (ADR 0162, #1901).
import { expect, test } from 'bun:test';
import { createElement, createProject, type AddOnElement } from '../src/model';
import { PlaySession } from '../src/play';
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
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const CONTROLS = 'https://northtalk.org/add-ons/music-controls';
const KNOB = `${CONTROLS}#knob`;

/** A knob saved by an Add-on Folio hasn't loaded, with nested data. */
const savedKnob = {
  kind: KNOB,
  name: 'cutoff',
  left: 10,
  top: 20,
  width: 64,
  height: 64,
  visible: true,
  value: 0.25,
  range: { min: 0, max: 1, curve: [0, 0.5, 1] },
  binding: { instrument: 'bass', parameter: 'cutoff' },
};

const projectJson = (overrides: Record<string, unknown> = {}) => {
  const json = serializeProject(createProject('Knobs')) as Record<
    string,
    unknown
  >;
  const pages = json.pages as { elements: unknown[] }[];
  pages[0]!.elements = [structuredClone(savedKnob)];
  return {
    ...json,
    addOns: [{ id: CONTROLS, version: '1.2.0' }],
    ...overrides,
  };
};

const file = (json: unknown) =>
  writeZip([
    { name: 'mimetype', data: encode(PROJECT_MIMETYPE) },
    {
      name: 'project.json',
      data: encode(JSON.stringify(json, null, 2)),
      method: 8,
    },
  ]);

const savedJson = async (bytes: Uint8Array) =>
  decode((await readZip(bytes)).get('project.json')!);

test('an Element of an unloaded Add-on kind is written back byte for byte', async () => {
  const original = await file(projectJson());
  const { project, assets } = await readProjectFile(original);
  const knob = project.pages[0]!.elements[0] as AddOnElement;
  expect(knob.kind).toBe(KNOB);
  expect(knob.name).toBe('cutoff');
  expect(project.addOns).toEqual([{ id: CONTROLS, version: '1.2.0' }]);
  const written = await writeProjectFile(project, assets);
  expect(await savedJson(written)).toBe(await savedJson(original));
});

test("a placeholder's box, name and Script change; its Add-on data does not", async () => {
  const { project, assets } = await readProjectFile(await file(projectJson()));
  const knob = project.pages[0]!.elements[0] as AddOnElement;
  knob.left = 100;
  knob.name = 'resonance';
  knob.script = 'on change value v\nend change value\n';
  const saved = JSON.parse(
    await savedJson(await writeProjectFile(project, assets)),
  ) as { pages: { elements: Record<string, unknown>[] }[] };
  expect(saved.pages[0]!.elements[0]).toEqual({
    ...savedKnob,
    left: 100,
    name: 'resonance',
    script: 'on change value v\nend change value\n',
  });
});

test('a Project without Add-ons saves no addOns, and format 8 files read unchanged', async () => {
  const json = serializeProject(createProject('Plain'));
  expect(json).not.toHaveProperty('addOns');
  const old = migrateProjectJson({ ...json, format: 8 });
  expect(old).toEqual(json);
});

const issues = (json: unknown) => {
  const result = validateProjectJson(migrateProjectJson(json));
  return 'issues' in result ? result.issues : [];
};

test('the Project file refuses Add-on entries and kinds it cannot trust', () => {
  expect(issues(projectJson({ addOns: [] }))).toEqual([
    {
      path: 'pages[0].elements[0].kind',
      message: `the Add-on ${CONTROLS} is not in addOns`,
    },
  ]);
  expect(
    issues(
      projectJson({
        addOns: [
          { id: CONTROLS, version: '1.2.0' },
          { id: CONTROLS, version: '1.3.0' },
          { id: 'ftp://example.com/x', version: '1' },
          { id: `${CONTROLS}#knob`, version: '1.0.0', code: 'export {}' },
          { id: 'https://example.com/pads', version: '1.0.0', hash: 'ABC' },
        ],
      }),
    ),
  ).toEqual([
    { path: 'addOns[2].id', message: 'expected an http or https URL' },
    { path: 'addOns[2].version', message: 'expected a version such as 1.2.0' },
    { path: 'addOns[3].id', message: 'an Add-on URL has no #fragment' },
    { path: 'addOns[3]', message: 'a Project Add-on needs both code and hash' },
    { path: 'addOns[4]', message: 'a Project Add-on needs both code and hash' },
    { path: 'addOns[4].hash', message: 'expected a lowercase hex SHA-256' },
    { path: 'addOns[1].id', message: 'another Add-on has this URL' },
  ]);
  const unknown = projectJson() as Record<string, unknown>;
  (unknown.pages as { elements: { kind: string }[] }[])[0]!.elements[0]!.kind =
    'knob';
  expect(issues(unknown)).toEqual([
    {
      path: 'pages[0].elements[0].kind',
      message: 'unknown Element kind "knob"',
    },
  ]);
});

test("a Project Add-on's code must match its hash", async () => {
  const code = 'export const kinds = [];';
  const hash = await sha256Hex(encode(code));
  const pads = { id: 'https://example.com/pads', version: '0.1.0', code, hash };
  const { project } = await readProjectFile(
    await file(
      projectJson({ addOns: [{ id: CONTROLS, version: '1.2.0' }, pads] }),
    ),
  );
  expect(project.addOns![1]).toEqual(pads);
  await expect(
    readProjectFile(
      await file(
        projectJson({
          addOns: [
            { id: CONTROLS, version: '1.2.0' },
            { ...pads, code: `${code} // changed` },
          ],
        }),
      ),
    ),
  ).rejects.toThrow(
    new ProjectFileError(
      'The code for the Add-on https://example.com/pads does not match its hash.',
    ),
  );
});

test("during Play, the Errors window names a placeholder's Add-on, and Scripts using it fail", async () => {
  const { project } = await readProjectFile(await file(projectJson()));
  const reader = createElement('button', 'reader');
  reader.script = 'on click\n  put the left of cutoff into x\nend click\n';
  const writer = createElement('button', 'writer');
  writer.script = 'on click\n  set the left of cutoff to 5\nend click\n';
  project.pages[0]!.elements.push(reader, writer);
  const play = new PlaySession(project);
  expect(play.problems.map(p => [p.owner.name, p.message])).toEqual([
    ['cutoff', `“cutoff” needs the Add-on ${CONTROLS}, which isn't loaded`],
  ]);
  for (const button of play.page.elements.slice(1)) {
    play.send(button, 'click');
    for (let i = 0; i < 100 && play.pump(0n).state === 'sliced'; i++) {
      // Runs until idle.
    }
  }
  expect(
    play.problems.slice(1).map(p => [p.owner.name, p.line, p.message]),
  ).toEqual([
    ['reader', 2, '"placeholder" failed while doing "left"'],
    ['writer', 2, '"placeholder" failed while doing "left"'],
  ]);
  expect(play.page.elements[0]!.left).toBe(10);
  play.stop(0n);
});
