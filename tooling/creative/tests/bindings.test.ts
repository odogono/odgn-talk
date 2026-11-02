// Control bindings (#1904): a control bound to an Instrument parameter or
// the tempo sets it with no Run, saved with the Project and checked against
// the Instrument kind's parameters.
import { expect, test } from 'bun:test';
import {
  INSTRUMENTS_REF,
  SYNTH_KIND,
  YM2149_KIND,
} from './helpers/instruments';
import controls, { CONTROLS_ADD_ON } from '../src/add-ons/controls';
import { AddOnLoader } from '../src/add-ons/loader';
import { bindingChoices, bindingProblems, boundChange } from '../src/bindings';
import { StackEditor } from '../src/editing';
import { createAnyElement } from '../src/elements/registry';
import { createInstrument } from '../src/instruments/registry';
import {
  createProject,
  type AddOnElement,
  type AddOnKind,
  type Project,
} from '../src/model';
import { PlayHarness } from '../src/play-harness';
import { serializeProject, validateProjectJson } from '../src/project-file';

new AddOnLoader().register(controls);

/** Runs a Message Box expression in the session and reads its result. */
const read = async (harness: PlayHarness, expression: string) => {
  const outcome = harness.play.runMessage(expression);
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  await harness.settle();
  return String(await outcome.result);
};

const kind = (name: string) => `${CONTROLS_ADD_ON}#${name}` as AddOnKind;
const control = (
  name: string,
  element: string,
  extra: Record<string, unknown> = {},
) => ({ ...createAnyElement(kind(name), element), ...extra }) as AddOnElement;

/** A synth, a YM2149 and a knob, toggle and XY pad bound to them. */
const bound = (): Project => {
  const project = createProject('Bound');
  project.addOns = [INSTRUMENTS_REF, { id: CONTROLS_ADD_ON, version: '1.0.0' }];
  project.instruments.push(
    createInstrument(SYNTH_KIND, 'bass'),
    createInstrument(YM2149_KIND, 'chip'),
  );
  project.pages[0]!.elements.push(
    control('knob', 'cutoff', {
      min: 20,
      max: 20_000,
      value: 1000,
      bindings: { value: 'bass.cutoff' },
    }),
    control('toggle', 'tone', { bindings: { value: 'chip.tone' } }),
    control('xy', 'pad', { bindings: { x: 'bass.pan', y: 'tempo' } }),
  );
  return project;
};

test('a bound knob sets its parameter with no Run, and still sends change', async () => {
  const project = bound();
  project.pages[0]!.elements[0]!.script =
    'script variable last = 0\non change v\n put v into last\nend change';
  const harness = await PlayHarness.start(project);
  const from = harness.sent.length;
  await harness.control('cutoff', { value: 2500 });
  expect(harness.sent.slice(from)).toEqual([
    {
      instrument: 'bass',
      commands: [{ kind: 'set', parameter: 'cutoff', value: 2500 }],
    },
  ]);
  expect(harness.play.problems).toEqual([]);
  // Its Script's change Handler ran too.
  const knob = harness.play.messageTargets.find(t =>
    t.label.endsWith('/cutoff'),
  )!;
  const last = harness.play.runMessage('last', knob.id);
  await harness.settle();
  expect(last.ok && String(await last.result)).toBe('2500');
  // Scripts read the parameter as the knob left it.
  expect(await read(harness, 'the cutoff of bass')).toBe('2500');
});

test('a bound toggle sets a switch, and an XY pad scales across ranges', async () => {
  const harness = await PlayHarness.start(bound());
  const from = harness.sent.length;
  await harness.control('tone', { value: false });
  await harness.control('pad', { x: 0.75, y: 0.5 });
  expect(harness.sent.slice(from).map(m => m.commands[0])).toEqual([
    { kind: 'set', parameter: 'tone', value: false },
    { kind: 'set', parameter: 'pan', value: 0.5 },
  ]);
  expect(harness.play.transport.tempo).toBe(210);
});

test('a control unbound, or bound to what is missing, sets nothing', async () => {
  const project = bound();
  project.pages[0]!.elements[0]!.bindings = { value: 'lead.cutoff' };
  const harness = await PlayHarness.start(project);
  const from = harness.sent.length;
  await harness.control('cutoff', { value: 2500 });
  expect(harness.sent.slice(from)).toEqual([]);
  expect(harness.play.problems).toMatchObject([
    {
      line: 1,
      message: 'cutoff’s value binding: No Instrument is named “lead”',
    },
  ]);
});

test('the page applying a binding leaves the worker only recording it', async () => {
  const harness = await PlayHarness.start(bound());
  const from = harness.sent.length;
  harness.play.control(
    harness.element('cutoff'),
    { value: 300 },
    {
      applied: true,
    },
  );
  await harness.settle();
  expect(harness.sent.slice(from)).toEqual([]);
  expect(await read(harness, 'the cutoff of bass')).toBe('300');
});

test('bindings are checked against the Instrument kind’s parameters', () => {
  const project = bound();
  const [knob, toggle] = project.pages[0]!.elements;
  knob!.bindings = { value: 'bass.wobble' };
  toggle!.bindings = { value: 'bass.cutoff' };
  expect(bindingProblems(project).map(p => p.message)).toEqual([
    'cutoff’s value binding: bass has no parameter “wobble”',
    'tone’s value binding: bass.cutoff is not a switch',
  ]);
  expect(boundChange(project, knob!, 'value', 5)).toBeUndefined();
});

test('Info offers the parameters of the field’s shape, and tempo for numbers', () => {
  const project = bound();
  const [knob, toggle] = project.pages[0]!.elements;
  const knobChoices = bindingChoices(project, knob!, 'value').map(c => c.value);
  expect(knobChoices).toContain('tempo');
  expect(knobChoices).toContain('bass.cutoff');
  expect(knobChoices).not.toContain('chip.tone');
  const toggleChoices = bindingChoices(project, toggle!, 'value');
  expect(toggleChoices.map(c => c.value)).toContain('chip.tone');
  expect(toggleChoices.every(c => c.value.startsWith('chip.'))).toBe(true);
  const meter = control('meter', 'level');
  expect(bindingChoices(project, meter, 'value')).toEqual([
    { value: 'bass', label: 'bass output' },
    { value: 'chip', label: 'chip output' },
  ]);
});

test('bindings save with the Project, and a file can only bind what binds', () => {
  const json = serializeProject(bound());
  const result = validateProjectJson(json);
  expect(result).toHaveProperty('project.pages.0.elements.2.bindings', {
    x: 'bass.pan',
    y: 'tempo',
  });
  const pages = json.pages as { elements: Record<string, unknown>[] }[];
  pages[0]!.elements[1]!.bindings = { label: 'chip.tone' };
  pages[0]!.elements[2]!.bindings = { x: 'nonsense' };
  expect(validateProjectJson(json)).toMatchObject({
    issues: [
      { path: 'pages[0].elements[1].bindings.label' },
      { path: 'pages[0].elements[2].bindings.x' },
    ],
  });
});

test('binding in Info takes the target’s range, undoes in one step, and follows a rename', () => {
  const project = bound();
  project.pages[0]!.elements.push(control('slider', 'level'));
  const editor = new StackEditor(project);
  const slider = editor.page.elements[3]!;
  editor.edit(({ tree }) =>
    tree.setBinding(slider, 'value', 'bass.cutoff', { min: 20, max: 20_000 }),
  );
  expect(editor.page.elements[3]).toMatchObject({
    bindings: { value: 'bass.cutoff' },
    min: 20,
    max: 20_000,
    value: 20,
  });
  editor.edit(({ tree, project: live }) =>
    tree.changeInstrument(live.instruments[0]!.id!, { name: 'lead' }),
  );
  expect(editor.page.elements[0]!.bindings).toEqual({ value: 'lead.cutoff' });
  expect(editor.page.elements[2]!.bindings).toEqual({
    x: 'lead.pan',
    y: 'tempo',
  });
  editor.undo();
  editor.undo();
  expect(editor.page.elements[3]).toMatchObject({ min: 0, max: 1, value: 0 });
  expect(editor.page.elements[3]!.bindings).toBeUndefined();
});
