// Play browses every Project and Present is a Project action (ADR 0174), so
// the `play` setting format 12 added (#2028) is read and dropped.
import { expect, test } from 'bun:test';
import { CONTROLS_ADD_ON, CONTROLS_REF } from '../src/add-ons/controls/ids';
import { INSTRUMENTS_REF } from '../src/add-ons/instruments/ids';
import { createMusicBase } from '../src/base-projects';
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

const knob = {
  ...createElement('button', 'cutoff'),
  kind: `${CONTROLS_ADD_ON}#knob`,
};

test('Music no longer sets play', async () => {
  const { project } = await createMusicBase();
  expect(serializeProject(project)).not.toHaveProperty('play');
});

test('an old play value still loads, and is not kept', () => {
  for (const play of ['perform', 'present']) {
    const result = validateProjectJson({
      ...serializeProject(createProject('Set')),
      play,
    });
    expect(result).toHaveProperty('project');
    expect(
      serializeProject((result as { project: never }).project),
    ).not.toHaveProperty('play');
  }
  expect(
    migrateProjectJson(format11({ base: { name: 'music', version: 2 } })),
  ).not.toHaveProperty('play');
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
