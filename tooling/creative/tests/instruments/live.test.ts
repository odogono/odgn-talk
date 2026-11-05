// The Instruments window during Play (ADR 0167, #2081): an authored edit
// reaches the running Instrument, a Script's set changes only the playing
// value, and undo reaches both.
import { expect, test } from 'bun:test';
import { INSTRUMENTS_REF, SYNTH_KIND } from '../helpers/instruments';
import type { Envelope } from '@northtalk/tooling/worker-supervisor';
import controls, { CONTROLS_ADD_ON } from '../../src/add-ons/controls';
import { AddOnLoader } from '../../src/add-ons/loader';
import { boundControls } from '../../src/bindings';
import { StackEditor } from '../../src/editing';
import { createAnyElement } from '../../src/elements/registry';
import { changedParameters, withPlaying } from '../../src/instruments/live';
import { createInstrument } from '../../src/instruments/registry';
import { InstrumentSession } from '../../src/instruments/session';
import {
  createPalette,
  createProject,
  type AddOnElement,
  type AddOnKind,
  type Project,
} from '../../src/model';
import { PlayHost } from '../../src/play-host';
import type {
  PlayRequest,
  PlayResponse,
  PlayView,
} from '../../src/play-protocol';

new AddOnLoader().register(controls);

const band = (): Project => {
  const project = createProject('Band');
  project.addOns = [INSTRUMENTS_REF];
  project.instruments.push(
    createInstrument(SYNTH_KIND, 'bass'),
    createInstrument('sampler', 'drums'),
  );
  return project;
};

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
};

test('an authored drag, then its undo, are each heard by the running Instrument', () => {
  const editor = new StackEditor(band());
  const bass = editor.project.instruments[0]!;
  const saved = bass.parameters.cutoff!;
  let heard = editor.project.instruments;
  const hear = () => {
    const before = heard;
    heard = editor.project.instruments;
    return changedParameters(before, heard);
  };
  editor.edit(({ tree }) =>
    tree.changeInstrument(bass.id!, { parameter: 'cutoff', value: 2400 }),
  );
  expect(hear()).toEqual([
    { instrument: 'bass', parameter: 'cutoff', value: 2400 },
  ]);
  // The drag is one undo step, kept with the Project until undone.
  expect(editor.project.instruments[0]!.parameters.cutoff).toBe(2400);
  editor.undo();
  expect(editor.project.instruments[0]!.parameters.cutoff).toBe(saved);
  expect(hear()).toEqual([
    { instrument: 'bass', parameter: 'cutoff', value: saved },
  ]);
  editor.redo();
  expect(hear()).toEqual([
    { instrument: 'bass', parameter: 'cutoff', value: 2400 },
  ]);
  // Nothing changed, nothing heard.
  expect(hear()).toEqual([]);
});

test('an Instrument added or renamed is not sent, since Scripts reach it by name at load', () => {
  const editor = new StackEditor(band());
  const before = editor.project.instruments;
  const id = before[0]!.id!;
  editor.edit(({ tree }) => {
    tree.changeInstrument(id, { name: 'lead' });
    tree.changeInstrument(id, { parameter: 'cutoff', value: 900 });
    tree.addInstrument(SYNTH_KIND, 'pad');
  });
  expect(changedParameters(before, editor.project.instruments)).toEqual([]);
});

test('the page shows a live change before the worker reports it', () => {
  const playing = { bass: { cutoff: 800, waveform: 'saw' } };
  expect(
    withPlaying(playing, {
      instrument: 'bass',
      parameter: 'cutoff',
      value: 1600,
    }),
  ).toEqual({ bass: { cutoff: 1600, waveform: 'saw' } });
  // An Instrument the session doesn't have stays out.
  expect(
    withPlaying(playing, { instrument: 'lead', parameter: 'cutoff', value: 1 }),
  ).toBe(playing);
});

test('a window edit sets the playing value, and sends it unless the page already did', () => {
  const sent: unknown[] = [];
  const session = new InstrumentSession(band().instruments, message =>
    sent.push(message),
  );
  session.setParameter('bass', 'cutoff', 1500, true);
  session.setParameter('bass', 'resonance', 0.5, false);
  expect(session.parameters().bass).toMatchObject({
    cutoff: 1500,
    resonance: 0.5,
  });
  expect(sent).toEqual([
    {
      instrument: 'bass',
      commands: [{ kind: 'set', parameter: 'cutoff', value: 1500 }],
    },
  ]);
});

test('views carry the playing values: a Script’s set and a window edit, never the saved Project', async () => {
  const project = band();
  const saved = project.instruments[0]!.parameters.cutoff;
  const views: PlayView[] = [];
  const host = new PlayHost(sent => {
    const { response } = structuredClone(sent) as { response: PlayResponse };
    if (response.kind === 'view') {
      views.push(response);
    }
  });
  let id = 1;
  const request = (request: PlayRequest) =>
    host.receive({ id: id++, request } satisfies Envelope<PlayRequest>);
  request({
    kind: 'open',
    session: 1,
    project: structuredClone(project),
    pageIndex: 0,
    seed: 0n,
  });
  const playing = () =>
    views.filter(view => view.instruments).at(-1)?.instruments?.bass?.cutoff;
  expect(playing()).toBe(saved);
  request({
    kind: 'message',
    session: 1,
    text: 'set the cutoff of bass to 1200',
  });
  await until(() => playing() === 1200);
  // The thumb shows 1200; the Project's saved value is untouched.
  expect(project.instruments[0]!.parameters.cutoff).toBe(saved);
  request({
    kind: 'instrumentParameter',
    session: 1,
    instrument: 'bass',
    parameter: 'cutoff',
    value: 3000,
    applied: true,
  });
  expect(playing()).toBe(3000);
  // A view that changes no parameter leaves them out.
  const count = views.length;
  request({ kind: 'message', session: 1, text: 'put 1 into x' });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(views.slice(count).every(view => !view.instruments)).toBe(true);
  request({ kind: 'stop', session: 1 });
});

test('the window marks each parameter a control is bound to, Palettes too', () => {
  const project = band();
  project.addOns = [INSTRUMENTS_REF, { id: CONTROLS_ADD_ON, version: '1.0.0' }];
  const kind = (name: string) => `${CONTROLS_ADD_ON}#${name}` as AddOnKind;
  const control = (name: string, element: string, bindings: object) =>
    ({ ...createAnyElement(kind(name), element), bindings }) as AddOnElement;
  project.pages[0]!.elements.push(
    control('knob', 'cut', { value: 'bass.cutoff' }),
    control('xy', 'pad', { x: 'bass.pan', y: 'tempo' }),
  );
  const palette = createPalette('mixer');
  palette.elements.push(control('knob', 'cut2', { value: 'bass.cutoff' }));
  project.pages.push(palette);
  expect(Object.fromEntries(boundControls(project, 'bass'))).toEqual({
    cutoff: ['cut', 'cut2'],
    pan: ['pad'],
  });
  expect(boundControls(project, 'drums').size).toBe(0);
});
