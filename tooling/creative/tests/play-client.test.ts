// PlayClient (#2270), the page's handle on the worker's Play Session, run
// against a PlayHost in this process, every message copied as postMessage
// copies it.
import { afterEach, expect, test } from 'bun:test';
import { INSTRUMENTS_REF, SYNTH_KIND } from './helpers/instruments';
import controls, { CONTROLS_ADD_ON } from '../src/add-ons/controls';
import { AddOnLoader } from '../src/add-ons/loader';
import { createAnyElement } from '../src/elements/registry';
import { createInstrument } from '../src/instruments/registry';
import { type InstrumentMessage } from '../src/instruments/session';
import {
  createElement,
  createProject,
  type AddOnElement,
  type AddOnKind,
  type Project,
} from '../src/model';
import { PlayClient, type PlayClientOptions } from '../src/play-client';
import {
  type BreakpointView,
  type PlayRequest,
  type PlayResponse,
} from '../src/play-protocol';
import { type LoadedSource, type SourceBreakpoints } from '../src/scripts';
import { giveIds } from './helpers/ids';
import { inProcessPlay } from './helpers/in-process-play';

new AddOnLoader().register(controls);

const PAGE_SCRIPT = 'on openPage\n put 1 into x\n put 2 into x\nend openPage';
const LIBRARY = 'on double n\n return n * 2\nend double';

/** A Page Script, a button's Script, a Library and a Test Script. */
const fixture = (): Project => {
  const project = createProject('Client');
  project.pages[0]!.script = PAGE_SCRIPT;
  const go = createElement('button', 'go');
  go.script = 'on click\n put 3 into y\nend click';
  project.pages[0]!.elements.push(go);
  project.libraries.push({ name: 'maths', source: LIBRARY });
  project.testScripts.push({ name: 'checks', source: 'on test\nend test' });
  return giveIds(project);
};

const kind = (name: string) => `${CONTROLS_ADD_ON}#${name}` as AddOnKind;
const control = (
  name: string,
  element: string,
  extra: Record<string, unknown> = {},
) => ({ ...createAnyElement(kind(name), element), ...extra }) as AddOnElement;

/** A synth with a knob and an XY pad bound to it, and an unbound knob. */
const bound = (): Project => {
  const project = createProject('Bound');
  project.addOns = [INSTRUMENTS_REF, { id: CONTROLS_ADD_ON, version: '1.0.0' }];
  project.instruments.push(createInstrument(SYNTH_KIND, 'bass'));
  project.pages[0]!.elements.push(
    control('knob', 'cutoff', {
      min: 20,
      max: 20_000,
      value: 1000,
      bindings: { value: 'bass.cutoff' },
    }),
    control('xy', 'pad', { bindings: { x: 'bass.pan', y: 'bass.cutoff' } }),
    control('knob', 'free'),
  );
  return giveIds(project);
};

/** What the page did, in order: audio sends and requests to the worker. */
type Step = { audio: InstrumentMessage } | { request: PlayRequest };

const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop();
  }
});

/** A client on an in-process host, with a fake Code Browser and audio. */
const setUp = (overrides: Partial<PlayClientOptions> = {}) => {
  const steps: Step[] = [];
  const play = inProcessPlay({
    onRequest: request => steps.push({ request }),
  });
  const shown: { loaded: LoadedSource | undefined } = { loaded: undefined };
  const marks: SourceBreakpoints[] = [];
  const state = { audio: true as boolean | undefined, generation: 1 };
  const client = new PlayClient(play.transport, {
    audio: () =>
      state.audio === undefined
        ? undefined
        : {
            send: message => {
              steps.push({ audio: message });
              return state.audio!;
            },
          },
    breakpoints: {
      all: () => marks,
      setLoaded: loaded => (shown.loaded = loaded),
    },
    browsing: () => true,
    generation: () => state.generation,
    ...overrides,
  });
  const heard: PlayResponse[] = [];
  client.onEvent(response => heard.push(response));
  const open = (project: Project) =>
    client.open(project, () => ({ pageIndex: 0, seed: 0n }));
  stops.push(() => client.end());
  /** The Breakpoints requests the host received. */
  const sentBreakpoints = (): BreakpointView[][] =>
    play.requests.flatMap(r =>
      r.kind === 'breakpoints' ? [r.breakpoints] : [],
    );
  return {
    client,
    heard,
    marks,
    open,
    play,
    sentBreakpoints,
    shown,
    state,
    steps,
  };
};

/** Waits for every reply posted so far to arrive. */
const replies = () => new Promise(resolve => setTimeout(resolve, 5));

test('Breakpoints are placed only in source as the session loaded it', async () => {
  const project = fixture();
  const { client, marks, open, sentBreakpoints, shown } = setUp();
  const page = project.pages[0]!;
  const go = page.elements[0]!;
  const library = project.libraries[0]!;
  const tests = project.testScripts[0]!;
  marks.push(
    {
      lines: [2, 3],
      source: { kind: 'script', id: page.id! },
      text: PAGE_SCRIPT,
    },
    // Edited since Play loaded it.
    {
      lines: [2],
      source: { kind: 'script', id: go.id! },
      text: 'on click\nend click',
    },
    { lines: [2], source: { kind: 'library', id: library.id! }, text: LIBRARY },
    // Test Scripts never load in Play.
    {
      lines: [1],
      source: { kind: 'test', id: tests.id! },
      text: 'on test\nend test',
    },
    // Not in the Project Play loaded.
    { lines: [1], source: { kind: 'script', id: 999 }, text: 'on x\nend x' },
  );
  open(project);
  client.loadBreakpoints();
  expect(sentBreakpoints()).toEqual([
    [
      { line: 2, place: { kind: 'script', id: page.id! } },
      { line: 3, place: { kind: 'script', id: page.id! } },
      { line: 2, place: { kind: 'library', id: library.id! } },
    ],
  ]);
  // The Code Browser reads what Play loaded through the client.
  expect(shown.loaded?.({ kind: 'library', id: library.id! })).toBe(LIBRARY);
  expect(shown.loaded?.({ kind: 'test', id: tests.id! })).toBeUndefined();
  // Unchanged, they aren't sent again.
  client.sendBreakpoints();
  expect(sentBreakpoints()).toHaveLength(1);
  marks.splice(1);
  client.sendBreakpoints();
  expect(sentBreakpoints().at(-1)).toEqual([
    { line: 2, place: { kind: 'script', id: page.id! } },
    { line: 3, place: { kind: 'script', id: page.id! } },
  ]);
  // Stopping takes the loaded source away from the Code Browser.
  await client.end();
  expect(shown.loaded).toBeUndefined();
});

test('Breakpoints go only while browsing', () => {
  const project = fixture();
  const { client, marks, open, sentBreakpoints } = setUp({
    browsing: () => false,
  });
  marks.push({
    lines: [2],
    source: { kind: 'script', id: project.pages[0]!.id! },
    text: PAGE_SCRIPT,
  });
  open(project);
  client.loadBreakpoints();
  expect(sentBreakpoints()).toEqual([]);
});

test('a Punch In taken becomes the loaded source, and its Breakpoints go', async () => {
  const project = fixture();
  const { client, marks, open, sentBreakpoints, shown } = setUp();
  const page = { kind: 'script', id: project.pages[0]!.id! } as const;
  const punched = 'on openPage\n put 5 into x\nend openPage';
  // Set in the source as edited, so not placed until it is Punched In.
  marks.push({ lines: [2], source: page, text: punched });
  open(project);
  client.loadBreakpoints();
  expect(sentBreakpoints()).toEqual([[]]);
  expect(await client.punchIn(page, punched)).toEqual({ kind: 'now' });
  expect(client.loadedSource(page)).toBe(punched);
  expect(shown.loaded?.(page)).toBe(punched);
  expect(sentBreakpoints()).toEqual([[], [{ line: 2, place: { ...page } }]]);
});

test('a Punch In of source Play did not load asks nothing', async () => {
  const project = fixture();
  const { client, open, play } = setUp();
  open(project);
  const before = play.requests.length;
  expect(
    await client.punchIn(
      { kind: 'test', id: project.testScripts[0]!.id! },
      'on test\nend test',
    ),
  ).toEqual({ kind: 'unplaced' });
  expect(await client.punchIn({ kind: 'script', id: 999 }, '')).toEqual({
    kind: 'unplaced',
  });
  expect(play.requests.length).toBe(before);
});

test('a Punch In refused leaves the loaded source as it was', async () => {
  const project = fixture();
  const { client, open } = setUp();
  const page = { kind: 'script', id: project.pages[0]!.id! } as const;
  open(project);
  await client.end();
  // The host has no session, so nothing is loaded.
  expect(await client.punchIn(page, 'on openPage\nend openPage')).toEqual({
    kind: 'notLoaded',
  });
  expect(client.loadedSource(page)).toBe(PAGE_SCRIPT);
});

test('replies and views from an earlier session are dropped', async () => {
  const project = fixture();
  const { client, heard, open } = setUp();
  open(project);
  const page = { kind: 'script', id: project.pages[0]!.id! } as const;
  const punch = client.punchIn(page, 'on openPage\nend openPage');
  const variables = client.ask({ kind: 'variables' });
  // A second session opens before the first's replies arrive.
  expect(open(project)).toBe(2);
  expect(await punch).toEqual({ kind: 'stale' });
  expect(await variables).toBeUndefined();
  expect(client.loadedSource(page)).toBe(PAGE_SCRIPT);
  await replies();
  const sessions = heard.flatMap(r => ('session' in r ? [r.session] : []));
  expect(sessions.length).toBeGreaterThan(0);
  expect(new Set(sessions)).toEqual(new Set([2]));
  // The current session's replies still come.
  expect((await client.ask({ kind: 'variables' }))?.kind).toBe('variables');
});

test('the loaded Project is current until the editor has another', () => {
  const { client, open, state } = setUp();
  expect(client.projectCurrent()).toBe(false);
  open(fixture());
  expect(client.projectCurrent()).toBe(true);
  state.generation++;
  expect(client.projectCurrent()).toBe(false);
  open(fixture());
  expect(client.projectCurrent()).toBe(true);
});

test('a bound control goes to the audio, then to the worker as applied', () => {
  const project = bound();
  const { client, open, steps } = setUp();
  open(project);
  steps.splice(0);
  const knob = project.pages[0]!.elements[0]!;
  client.control(knob, { value: 2500 }, 0);
  expect(steps).toEqual([
    {
      audio: {
        instrument: 'bass',
        commands: [{ kind: 'set', parameter: 'cutoff', value: 2500 }],
      },
    },
    {
      request: {
        kind: 'control',
        session: 1,
        pageIndex: 0,
        target: 'cutoff',
        fields: { value: 2500 },
        applied: true,
      },
    },
  ]);
});

test('a control is not applied when an audio send fails, or nothing is bound', () => {
  const project = bound();
  const { client, open, play, state } = setUp();
  open(project);
  const [knob, , free] = project.pages[0]!.elements;
  const controlsSent = () => play.requests.filter(r => r.kind === 'control');
  state.audio = false;
  client.control(knob!, { value: 300 }, 0);
  state.audio = undefined;
  client.control(free!, { value: 0.5 }, 0);
  expect(controlsSent()).toEqual([
    {
      kind: 'control',
      session: 1,
      pageIndex: 0,
      target: 'cutoff',
      fields: { value: 300 },
    },
    // Nothing bound needs sending, so the worker has nothing to record.
    {
      kind: 'control',
      session: 1,
      pageIndex: 0,
      target: 'free',
      fields: { value: 0.5 },
      applied: true,
    },
  ]);
});

test('a control’s changes wait for its last, merged, and go together', async () => {
  const project = bound();
  const { client, open, play, state } = setUp();
  open(project);
  const [knob, pad] = project.pages[0]!.elements;
  const controlsSent = () =>
    play.requests.flatMap(r =>
      r.kind === 'control'
        ? [{ target: r.target, fields: r.fields, applied: r.applied }]
        : [],
    );
  client.control(pad!, { x: 0.1 }, 0);
  // One waiting change's audio send fails, so the merged change isn't
  // applied, though a later one's succeeds.
  state.audio = false;
  client.control(pad!, { y: 0.2 }, 0);
  state.audio = true;
  client.control(pad!, { x: 0.3 }, 0);
  // Another control, or the same name on another Page, goes at once.
  client.control(knob!, { value: 400 }, 0);
  client.control(pad!, { x: 0.9 }, 1);
  expect(controlsSent()).toEqual([
    { target: 'pad', fields: { x: 0.1 }, applied: true },
    { target: 'cutoff', fields: { value: 400 }, applied: true },
    { target: 'pad', fields: { x: 0.9 }, applied: true },
  ]);
  await replies();
  expect(controlsSent().slice(3)).toEqual([
    { target: 'pad', fields: { y: 0.2, x: 0.3 }, applied: undefined },
  ]);
  // Once that one is answered too, the control is free again.
  await replies();
  client.control(pad!, { y: 0.5 }, 0);
  expect(controlsSent().at(-1)).toEqual({
    target: 'pad',
    fields: { y: 0.5 },
    applied: true,
  });
});

test('an Instrument Parameter goes to the audio, then is recorded', () => {
  const { client, open, state, steps } = setUp();
  open(bound());
  steps.splice(0);
  const change = { instrument: 'bass', parameter: 'cutoff', value: 900 };
  client.setParameter(change);
  state.audio = false;
  client.setParameter(change);
  const set: Step = {
    audio: {
      instrument: 'bass',
      commands: [{ kind: 'set', parameter: 'cutoff', value: 900 }],
    },
  };
  expect(steps).toEqual([
    set,
    {
      request: {
        kind: 'instrumentParameter',
        session: 1,
        ...change,
        applied: true,
      },
    },
    set,
    { request: { kind: 'instrumentParameter', session: 1, ...change } },
  ]);
});
