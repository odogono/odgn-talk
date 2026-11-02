// The synth and YM2149 as the built-in Instruments Add-on (ADR 0162, #1901).
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProject } from '../../src/model';
import { PlaySession } from '../../src/play';
import {
  CURRENT_FORMAT,
  migrateProjectJson,
  serializeProject,
  validateProjectJson,
} from '../../src/project-file';
import { ProjectTree } from '../../src/tree/project-tree';
import { instrumentProblems } from '../../src/instruments/registry';
import { build, dist } from '../../tools/build';
import {
  INSTRUMENTS_REF,
  SYNTH_KIND,
  YM2149_KIND,
} from '../helpers/instruments';

test('format 9 Projects name the synth and YM2149 by the Add-on and list it', () => {
  const json = serializeProject(createProject('Old'));
  const old = {
    ...json,
    format: 9,
    instruments: [
      { name: 'drums', kind: 'sampler', voices: 8, parameters: {} },
      { name: 'bass', kind: 'synth', voices: 8, parameters: { cutoff: 900 } },
      { name: 'chip', kind: 'ym2149', voices: 3, parameters: {} },
    ],
  };
  const migrated = migrateProjectJson(old);
  expect(migrated.format).toBe(CURRENT_FORMAT);
  expect(migrated.addOns).toEqual([INSTRUMENTS_REF]);
  expect((migrated.instruments as { kind: string }[]).map(i => i.kind)).toEqual(
    ['sampler', SYNTH_KIND, YM2149_KIND],
  );
  // Only samplers: nothing to list.
  const plain = migrateProjectJson({
    ...old,
    instruments: [old.instruments[0]],
  });
  expect(plain).not.toHaveProperty('addOns');
});

const THEREMIN = 'https://example.com/odd#theremin';

test("an Instrument whose Add-on isn't loaded keeps its settings and is reported during Play", () => {
  const json = {
    ...serializeProject(createProject('Odd')),
    addOns: [{ id: 'https://example.com/odd', version: '1.0.0' }],
    instruments: [
      { name: 'wobble', kind: THEREMIN, voices: 99, parameters: { pitch: 7 } },
    ],
  };
  const result = validateProjectJson(json);
  if (!('project' in result)) {
    throw new Error(JSON.stringify(result.issues));
  }
  expect(result.project.instruments[0]).toEqual(json.instruments[0]);
  expect(instrumentProblems(result.project.instruments)).toEqual([]);
  expect(serializeProject(result.project).instruments).toEqual(
    json.instruments,
  );
  const play = new PlaySession(result.project);
  expect(play.problems.map(p => p.message)).toEqual([
    "Instrument “wobble” needs the Add-on https://example.com/odd, which isn't loaded",
  ]);
  play.stop(0n);
  // An unlisted Add-on is refused, as for Elements.
  const unlisted = validateProjectJson({ ...json, addOns: [] });
  expect('issues' in unlisted && unlisted.issues).toEqual([
    {
      path: 'instruments[0].kind',
      message: 'the Add-on https://example.com/odd is not in addOns',
    },
  ]);
});

test('adding an Add-on Instrument lists its Add-on once', () => {
  const tree = new ProjectTree(createProject('Band'));
  tree.addInstrument(SYNTH_KIND, 'bass');
  tree.addInstrument(YM2149_KIND, 'chip');
  expect(tree.snapshot().addOns).toEqual([INSTRUMENTS_REF]);
});

test("Folio's own bundle leaves the synth and YM2149 to the Add-on", async () => {
  await build({ minify: true });
  const main = readFileSync(resolve(dist, 'main.js'), 'utf8');
  const worklet = readFileSync(resolve(dist, 'instruments.worklet.js'), 'utf8');
  const chunk = readFileSync(
    resolve(dist, 'add-ons/instruments-1.0.0.js'),
    'utf8',
  );
  const engines = readFileSync(
    resolve(dist, 'add-ons/instruments-1.0.0.worklet.js'),
    'utf8',
  );
  const synth = "The low-pass filter's cutoff, in hertz.";
  const ym = "Whether each voice plays the chip's noise.";
  for (const text of [synth, ym]) {
    expect(main).not.toContain(text);
    expect(worklet).not.toContain(text);
    expect(chunk).toContain(text);
    expect(engines).toContain(text);
  }
}, 60_000);
