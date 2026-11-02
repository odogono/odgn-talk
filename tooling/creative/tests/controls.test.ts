// The controls Add-on's kinds, and Play delivering `change` (#1902).
import { expect, test } from 'bun:test';
import controls, { CONTROLS_ADD_ON } from '../src/add-ons/controls';
import { AddOnLoader } from '../src/add-ons/loader';
import { createAnyElement, kindOf } from '../src/elements/registry';
import {
  createElement,
  createProject,
  type AddOnElement,
  type AddOnKind,
} from '../src/model';
import { PlaySession } from '../src/play';
import {
  readProjectFile,
  serializeProject,
  validateProjectJson,
  writeProjectFile,
} from '../src/project-file';

expect(new AddOnLoader().register(controls)).toBeUndefined();

const kind = (name: string) => `${CONTROLS_ADD_ON}#${name}` as AddOnKind;
type Fields = Record<string, unknown>;
const fields = (element: unknown) => element as AddOnElement & Fields;

const drain = (play: PlaySession) => {
  for (let i = 0; i < 100 && play.pump(0n).state === 'sliced'; i++) {
    // Runs until idle.
  }
};

test('each control is created with its defaults', () => {
  expect(createAnyElement(kind('slider'), 'volume')).toMatchObject({
    kind: kind('slider'),
    value: 0,
    min: 0,
    max: 1,
    step: 0,
  });
  expect(createAnyElement(kind('toggle'), 'mute')).toMatchObject({
    value: false,
  });
  expect(createAnyElement(kind('xy'), 'pad')).toMatchObject({ x: 0.5, y: 0.5 });
  expect(createAnyElement(kind('meter'), 'level')).toMatchObject({ value: 0 });
  expect(kindOf(kind('knob')).label).toBe('Knob');
});

test('reading a control fits its value into its range and onto its step', async () => {
  const project = createProject('Controls');
  project.addOns = [{ id: CONTROLS_ADD_ON, version: '1.0.0' }];
  project.pages[0]!.elements.push(
    {
      ...createAnyElement(kind('knob'), 'tone'),
      min: 10,
      max: 20,
      step: 5,
      value: 17,
    } as unknown as AddOnElement,
    {
      ...createAnyElement(kind('xy'), 'pad'),
      x: 3,
      y: -1,
    } as unknown as AddOnElement,
  );
  const result = validateProjectJson(serializeProject(project));
  if (!('project' in result)) {
    throw new Error(JSON.stringify(result.issues));
  }
  const [knob, pad] = result.project.pages[0]!.elements.map(fields);
  expect(knob!.value).toBe(15);
  expect([pad!.x, pad!.y]).toEqual([1, 0]);
  // Saving keeps the Add-on listed, and reading it back keeps the values.
  const read = await readProjectFile(
    await writeProjectFile(result.project, new Map()),
  );
  expect(read.project.addOns).toEqual([
    { id: CONTROLS_ADD_ON, version: '1.0.0' },
  ]);
  expect(fields(read.project.pages[0]!.elements[0]).value).toBe(15);
});

const playing = () => {
  const project = createProject('Mixer');
  project.addOns = [{ id: CONTROLS_ADD_ON, version: '1.0.0' }];
  const slider = createAnyElement(kind('slider'), 'volume');
  slider.script =
    'on change value\n  set the left of shown to value * 100\nend change\n';
  const pad = createAnyElement(kind('xy'), 'pad');
  // The Page hears a change its control doesn't handle.
  project.pages[0]!.script =
    'on change x, y\n  set the top of shown to (x + y) * 100\nend change\n';
  project.pages[0]!.elements.push(
    slider,
    pad,
    createElement('button', 'shown'),
  );
  const play = new PlaySession(project);
  drain(play);
  return play;
};

test('a reader change sets the value in Play State and sends change with it', () => {
  const play = playing();
  const [volume, pad, shown] = play.page.elements;
  play.control(volume!, { value: 0.25 });
  drain(play);
  expect(play.problems).toEqual([]);
  expect(fields(volume).value).toBe(0.25);
  expect(fields(shown).left).toBe(25);
  play.control(pad!, { x: 0.5, y: 0.25 });
  drain(play);
  expect(fields(shown).top).toBe(75);
  play.stop(0n);
});

test('a value the control refuses changes nothing and sends nothing', () => {
  const play = playing();
  const [volume, , shown] = play.page.elements;
  play.control(volume!, { value: 7, name: 1 });
  drain(play);
  expect(fields(volume).value).toBe(0);
  expect(fields(shown).left).toBe(40);
  play.stop(0n);
});
