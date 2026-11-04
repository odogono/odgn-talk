// What a Project offers its author follows the Add-ons it lists (#2025).
import { expect, test } from 'bun:test';
import { BUILT_IN_ADD_ONS } from '../src/add-ons/catalogue';
import { CONTROLS_ADD_ON, CONTROLS_REF } from '../src/add-ons/controls/ids';
import {
  INSTRUMENTS_REF,
  SYNTH_KIND,
  YM2149_KIND,
  synthInstrument,
} from '../src/add-ons/instruments/ids';
import {
  addOnRemovalProblem,
  offeredElementKinds,
  offeredInstrumentKinds,
} from '../src/add-ons/offered';
import { createFromBase } from '../src/base-projects';
import { StackEditor } from '../src/editing';
import { createElement, createProject, type AddOnElement } from '../src/model';

const knob = (name: string): AddOnElement =>
  ({
    ...createElement('button', name),
    kind: `${CONTROLS_ADD_ON}#knob`,
  }) as unknown as AddOnElement;

test('a Blank Project offers no Add-on kinds, only the sampler', async () => {
  const { project } = await createFromBase('blank', 'Untitled');
  expect(offeredElementKinds(project.addOns, BUILT_IN_ADD_ONS)).toEqual([]);
  expect(
    offeredInstrumentKinds(project.addOns, BUILT_IN_ADD_ONS).map(k => k.kind),
  ).toEqual(['sampler']);
});

test('a listed Add-on offers its kinds, the others none', () => {
  const project = createProject('Controls');
  project.addOns = [CONTROLS_REF];
  expect(
    offeredElementKinds(project.addOns, BUILT_IN_ADD_ONS).map(k => k.label),
  ).toEqual(['Slider', 'Knob', 'Toggle', 'XY pad', 'Level meter']);
  project.addOns = [INSTRUMENTS_REF];
  expect(offeredElementKinds(project.addOns, BUILT_IN_ADD_ONS)).toEqual([]);
  expect(
    offeredInstrumentKinds(project.addOns, BUILT_IN_ADD_ONS).map(k => k.kind),
  ).toEqual(['sampler', SYNTH_KIND, YM2149_KIND]);
});

test('an Add-on in use is not removed, and says what uses it', () => {
  const project = createProject('Set');
  project.addOns = [INSTRUMENTS_REF, CONTROLS_REF];
  project.instruments.push(synthInstrument('bass'));
  project.pages[0]!.elements.push(knob('cutoff'), knob('drive'));
  expect(addOnRemovalProblem(project, CONTROLS_ADD_ON)).toBe(
    '“cutoff” and “drive” use it',
  );
  expect(addOnRemovalProblem(project, INSTRUMENTS_REF.id)).toBe(
    '“bass” uses it',
  );
  const editor = new StackEditor(project);
  expect(editor.edit(({ tree }) => tree.stopUsingAddOn(CONTROLS_ADD_ON))).toBe(
    '“cutoff” and “drive” use it',
  );
  expect(editor.project.addOns).toHaveLength(2);
});

test('an unused Add-on is removed as one undoable edit', () => {
  const project = createProject('Set');
  project.addOns = [CONTROLS_REF];
  const editor = new StackEditor(project);
  expect(
    editor.edit(({ tree }) => tree.stopUsingAddOn(CONTROLS_ADD_ON)),
  ).toBeUndefined();
  expect(editor.project.addOns).toBeUndefined();
  editor.undo();
  expect(editor.project.addOns).toEqual([CONTROLS_REF]);
});
