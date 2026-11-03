// A Project chooses whether Play presents or performs it (#2028).
import { expect, test } from 'bun:test';
import { CONTROLS_ADD_ON, CONTROLS_REF } from '../src/add-ons/controls/ids';
import { INSTRUMENTS_REF } from '../src/add-ons/instruments/ids';
import { createFromBase, createMusicBase } from '../src/base-projects';
import { StackEditor } from '../src/editing';
import { createElement, createProject } from '../src/model';
import {
  migrateProjectJson,
  serializeProject,
  validateProjectJson,
} from '../src/project-file';

/** A Project's JSON as format 11 wrote it, before `play`. */
const format11 = (overrides: Record<string, unknown> = {}) => ({
  ...serializeProject(createProject('Old')),
  format: 11,
  ...overrides,
});

const read = (json: Record<string, unknown>) => {
  const result = validateProjectJson(migrateProjectJson(json));
  if (!('project' in result)) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.project;
};

const knob = {
  ...createElement('button', 'cutoff'),
  kind: `${CONTROLS_ADD_ON}#knob`,
};

test('a new Blank Project presents and Music performs', async () => {
  expect((await createFromBase('blank', 'Untitled')).project.play).toBe(
    undefined,
  );
  expect((await createMusicBase()).project.play).toBe('perform');
});

test('play round-trips, and anything but perform is refused', () => {
  const project = createProject('Set');
  project.play = 'perform';
  expect(read(serializeProject(project)).play).toBe('perform');
  expect(serializeProject(createProject('Plain'))).not.toHaveProperty('play');
  expect(
    validateProjectJson({ ...serializeProject(project), play: 'present' }),
  ).toMatchObject({ issues: [{ path: 'play' }] });
});

test('format 11 Projects from Music perform; others present', () => {
  expect(read(format11({ base: { name: 'music', version: 2 } })).play).toBe(
    'perform',
  );
  expect(
    read(format11({ base: { name: 'blank', version: 1 } })).play,
  ).toBeUndefined();
  expect(read(format11()).play).toBeUndefined();
});

test('format 11 Projects with controls list the controls Add-on once', () => {
  const page = serializeProject(createProject('Old')).pages as Record<
    string,
    unknown
  >[];
  const withKnob = [{ ...page[0], elements: [knob] }];
  expect(
    migrateProjectJson(format11({ pages: withKnob, addOns: [INSTRUMENTS_REF] }))
      .addOns,
  ).toEqual([INSTRUMENTS_REF, CONTROLS_REF]);
  expect(
    migrateProjectJson(format11({ pages: withKnob, addOns: [CONTROLS_REF] }))
      .addOns,
  ).toEqual([CONTROLS_REF]);
  const palette = { ...page[0], name: 'mixer', width: 200, elements: [knob] };
  expect(migrateProjectJson(format11({ palettes: [palette] })).addOns).toEqual([
    CONTROLS_REF,
  ]);
  expect(migrateProjectJson(format11())).not.toHaveProperty('addOns');
});

test('Play by Performing is one undoable edit', () => {
  const editor = new StackEditor(createProject('Set'));
  editor.edit(({ tree }) => tree.setPlayByPerforming(true));
  expect(editor.project.play).toBe('perform');
  editor.edit(({ tree }) => tree.setPlayByPerforming(false));
  expect(editor.project.play).toBeUndefined();
  editor.undo();
  expect(editor.project.play).toBe('perform');
});
