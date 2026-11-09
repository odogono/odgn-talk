import { expect, test } from 'bun:test';
import { settle } from '../../src/message';
import { createElement, createProject } from '../../src/model';
import { PlaySession } from '../../src/play';
import { InstrumentRack } from '../../src/instruments/rack';
import { createInstrument } from '../../src/instruments/registry';
import type { InstrumentMessage } from '../../src/instruments/session';
import { scriptManifest } from '../../src/script-manifest';
import { scriptNameProblems } from '../../src/script-names';
import { SYNTH_KIND, YM2149_KIND } from '../helpers/instruments';

const band = () => {
  const project = createProject('Band');
  const bass = createInstrument(SYNTH_KIND, 'bass');
  bass.parameters.cutoff = 800;
  project.instruments.push(bass, createInstrument('sampler', 'drums'));
  project.pages[0]!.elements.push(createElement('button', 'go'));
  return project;
};

const session = (project = band()) => {
  const sent: InstrumentMessage[] = [];
  const play = new PlaySession(project, 0, {
    instrumentBackend: message => sent.push(message),
  });
  const run = async (command: string) => {
    const started = play.runMessage(command);
    return started.ok
      ? settle(play, started.result, () => play.pump(0n))
      : { error: started.error };
  };
  return { play, run, sent };
};

test('a Script plays and releases notes on an Instrument by name', async () => {
  const { play, run, sent } = session();
  await run('tell bass to play "c3"\ntell bass to play 64, 0.5');
  await run('tell bass to release "c3"\ntell drums to play "kick", "g4"');
  await run('tell drums to play "snare"\ntell bass to stop');
  expect(play.problems).toEqual([]);
  expect(sent).toEqual([
    { instrument: 'bass', commands: [{ kind: 'note', note: 48, velocity: 1 }] },
    {
      instrument: 'bass',
      commands: [{ kind: 'note', note: 64, velocity: 0.5 }],
    },
    { instrument: 'bass', commands: [{ kind: 'release', note: 48 }] },
    {
      instrument: 'drums',
      commands: [{ kind: 'note', note: 67, sound: 'kick', velocity: 1 }],
    },
    {
      instrument: 'drums',
      commands: [{ kind: 'note', note: 60, sound: 'snare', velocity: 1 }],
    },
    { instrument: 'bass', commands: [{ kind: 'stop' }] },
  ]);
});

test('parameters are properties: a Script reads and sets them', async () => {
  const { play, run, sent } = session();
  expect(await run('the cutoff of bass')).toMatchObject({ text: '800' });
  await run(
    'set the cutoff of bass to 1200\nset the waveform of bass to "square"',
  );
  expect(await run('the cutoff of bass')).toMatchObject({ text: '1200' });
  expect(sent).toEqual([
    {
      instrument: 'bass',
      commands: [{ kind: 'set', parameter: 'cutoff', value: 1200 }],
    },
    {
      instrument: 'bass',
      commands: [{ kind: 'set', parameter: 'waveform', value: 'square' }],
    },
  ]);
  // The authored Project keeps its value (ADR 0041).
  expect(play.project.instruments[0]!.parameters.cutoff).toBe(800);
});

test('a frequency parameter takes Hz and kHz as well as a plain number', async () => {
  const { play, run, sent } = session();
  await run('set the cutoff of bass to 1200 Hz');
  expect(await run('the cutoff of bass')).toMatchObject({ text: '1200' });
  await run('set the cutoff of bass to 2 kHz');
  await run('set the cutoff of bass to 1.1 kHz');
  await run('set the cutoff of bass to 900');
  expect(await run('the cutoff of bass')).toMatchObject({ text: '900' });
  expect(play.problems).toEqual([]);
  expect(sent.map(m => m.commands)).toEqual(
    [1200, 2000, 1100, 900].map(value => [
      { kind: 'set', parameter: 'cutoff', value },
    ]),
  );
});

test('a frequency parameter refuses other Units and checks its range in Hz', async () => {
  const { run, sent } = session();
  // Each is `wrong kind`.
  expect(await run('set the cutoff of bass to 800 ms')).toMatchObject({
    error: expect.stringContaining('Expected "number or frequency"'),
  });
  expect(await run('set the cutoff of bass to 7 semitones')).toMatchObject({
    error: expect.stringContaining('Expected "number or frequency"'),
  });
  // Only a frequency parameter takes a Quantity.
  expect(await run('set the resonance of bass to 1 Hz')).toMatchObject({
    error: expect.stringContaining('Expected "number"'),
  });
  // 30 kHz is 30000 Hz, past the cutoff's range.
  expect(await run('set the cutoff of bass to 30 kHz')).toMatchObject({
    error: expect.stringContaining('failed while doing "cutoff"'),
  });
  expect(sent).toEqual([]);
});

test('envelope times take seconds and refuse other Unit Kinds', async () => {
  const { play, run, sent } = session();
  await run('set the attack of bass to 5 ms');
  expect(await run('the attack of bass')).toMatchObject({ text: '0.005' });
  await run('set the release of bass to 1.5 s');
  await run('set the decay of bass to 0.25');
  expect(play.problems).toEqual([]);
  expect(sent.map(m => m.commands)).toEqual([
    [{ kind: 'set', parameter: 'attack', value: 0.005 }],
    [{ kind: 'set', parameter: 'release', value: 1.5 }],
    [{ kind: 'set', parameter: 'decay', value: 0.25 }],
  ]);
  expect(await run('set the attack of bass to 1 kg')).toMatchObject({
    error: expect.stringContaining('Expected "number or exact duration"'),
  });
  expect(sent).toHaveLength(3);
});

test('a Project saved with plain envelope numbers opens unchanged', async () => {
  const project = band();
  project.instruments[0]!.parameters.attack = 0.02;
  const { run } = session(project);
  expect(await run('the attack of bass')).toMatchObject({ text: '0.02' });
});

test('bad notes, velocities and parameter values are Script errors', async () => {
  const { run, sent } = session();
  for (const command of [
    'tell bass to play "h2"',
    'tell bass to play 128',
    'tell bass to play 60, 2',
    'set the cutoff of bass to 5',
    'set the waveform of bass to "noise"',
  ]) {
    const result = await run(command);
    expect(result).toMatchObject({ error: expect.any(String) });
  }
  expect(sent).toEqual([]);
});

test('stopping a Play Session stops every Instrument', () => {
  const { play, sent } = session();
  play.stop(0n);
  expect(sent).toEqual([
    { instrument: 'bass', commands: [{ kind: 'stop' }] },
    { instrument: 'drums', commands: [{ kind: 'stop' }] },
  ]);
});

test('a stopped Script releases the notes it left playing', async () => {
  const project = band();
  project.pages[0]!.elements[0]!.script =
    'on click\n  tell bass to play "a3"\nend click\n';
  const { play, sent } = session(project);
  play.send(play.page.elements[0]!, 'click');
  while (play.pump(0n).state === 'sliced') {
    // Run the click to its end.
  }
  expect(sent).toEqual([
    { instrument: 'bass', commands: [{ kind: 'note', note: 57, velocity: 1 }] },
  ]);
  sent.length = 0;
  play.group.script('element:page1/go')!.stop('Stopped');
  play.pump(0n);
  expect(sent).toEqual([
    { instrument: 'bass', commands: [{ kind: 'release', note: 57 }] },
  ]);
});

test('every Script Manifest lists the Instruments as objects and Grants', () => {
  const project = band();
  const manifest = scriptManifest(project, project.pages[0]!.elements[0]!);
  expect(manifest.objects).toContainEqual({ name: 'bass', kind: 'synth' });
  expect(manifest.objects).toContainEqual({ name: 'drums', kind: 'sampler' });
  const grant = manifest.grants.find(g => g.name === 'bass')!;
  expect(grant.capability).toBe('synth');
  expect(grant.operations.map(o => o.name)).toEqual([
    'play',
    'release',
    'stop',
  ]);
  const synth = manifest.objectKinds.find(k => k.name === 'synth')!;
  // A frequency parameter shows the Units it takes (ADR 0166).
  expect(synth.props).toContainEqual({
    name: 'cutoff',
    shape: { oneOf: ['number', { unitKind: 'frequency' }] },
    readOnly: false,
    setCost: { fuel: 1 },
  });
  expect(synth.props).toContainEqual({
    name: 'resonance',
    shape: 'number',
    readOnly: false,
    setCost: { fuel: 1 },
  });
});

test('a Page or Element named like an Instrument is a name problem', () => {
  const project = band();
  project.pages[0]!.elements[0]!.name = 'bass';
  expect(scriptNameProblems(project).map(p => p.message)).toEqual([
    'Element on page1 “bass” conflicts with another Page, Element or Instrument name. Rename it in Info before Play or adding an action.',
  ]);
});

test('the rack mixes every Instrument and routes commands by name', () => {
  const setup = {
    instruments: [
      createInstrument(SYNTH_KIND, 'lead'),
      { ...createInstrument(YM2149_KIND, 'chip'), parameters: { pan: 1 } },
    ],
    samples: [],
  };
  const rack = new InstrumentRack(setup, 44_100);
  const left = new Float32Array(4410);
  const right = new Float32Array(4410);
  rack.process(left, right, 0);
  expect(left.some(v => v !== 0) || right.some(v => v !== 0)).toBe(false);
  rack.receive({
    instrument: 'chip',
    commands: [{ kind: 'note', note: 69, velocity: 1 }],
  });
  rack.receive({
    instrument: 'nobody',
    commands: [{ kind: 'note', note: 69, velocity: 1 }],
  });
  rack.process(left, right, 0.1);
  // The chip is panned hard right, and the lead is silent.
  expect(Math.max(...left.map(Math.abs))).toBeLessThan(1e-6);
  expect(Math.max(...right.map(Math.abs))).toBeGreaterThan(0.05);
  rack.receive({
    instrument: 'lead',
    commands: [{ kind: 'note', note: 60, velocity: 1 }],
  });
  rack.process(left, right, 0.2);
  expect(Math.max(...left.map(Math.abs))).toBeGreaterThan(0.05);
});

test('a Script sets a YM2149 arpeggio and its rate in Hz', async () => {
  const project = createProject('Chip');
  project.instruments.push(createInstrument(YM2149_KIND, 'lead'));
  const { play, run, sent } = session(project);
  await run('set the arpeggio of lead to "0 4 7"');
  await run('set the arpeggioRate of lead to 25 Hz');
  expect(await run('the arpeggioRate of lead')).toMatchObject({ text: '25' });
  expect(await run('set the arpeggio of lead to "0 x"')).toMatchObject({
    error: expect.anything(),
  });
  expect(play.problems).toEqual([]);
  expect(sent).toEqual([
    {
      instrument: 'lead',
      commands: [{ kind: 'set', parameter: 'arpeggio', value: '0 4 7' }],
    },
    {
      instrument: 'lead',
      commands: [{ kind: 'set', parameter: 'arpeggioRate', value: 25 }],
    },
  ]);
});
