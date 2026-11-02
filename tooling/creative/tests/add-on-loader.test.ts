// Loading built-in Add-ons and registering their kinds (ADR 0162, #1901).
import { expect, test } from 'bun:test';
import { AddOnLoader, compareVersions } from '../src/add-ons/loader';
import { projectWithAddOns } from '../src/add-ons/project';
import type { AddOnModule } from '../src/add-ons/api';
import type { CatalogueEntry } from '../src/add-ons/catalogue';
import { createAnyElement, kindOf } from '../src/elements/registry';
import { createElement, createProject, type AddOnElement } from '../src/model';
import { PlaySession } from '../src/play';
import { serializeProject, validateProjectJson } from '../src/project-file';
import counter, {
  COUNTER_ADD_ON,
  COUNTER_ENTRY,
  COUNTER_KIND,
} from './fixtures/counter-add-on';

const ENTRY = COUNTER_ENTRY;

const loaderWith = (
  importer: (entry: CatalogueEntry) => Promise<AddOnModule> = () =>
    Promise.resolve(counter),
) => new AddOnLoader({ catalogue: [ENTRY], importer });

/** A Project holding one counter, read while its Add-on isn't loaded. */
const projectWithCounter = (version = '1.0.0') => {
  const json = serializeProject(createProject('Counting'));
  (json.pages as { elements: unknown[] }[])[0]!.elements = [
    {
      kind: COUNTER_KIND,
      name: 'counter1',
      left: 0,
      top: 0,
      width: 80,
      height: 40,
      visible: true,
      count: 3,
    },
  ];
  json.addOns = [{ id: COUNTER_ADD_ON, version }];
  const result = validateProjectJson(json);
  if ('issues' in result) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.project;
};

test('versions compare by their numbers', () => {
  expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
  expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0);
});

test('a loaded Add-on turns its placeholders into its kind, saved at its version', async () => {
  const { project, problems } = await projectWithAddOns(
    projectWithCounter(),
    loaderWith(),
  );
  expect(problems).toEqual([]);
  const element = project.pages[0]!.elements[0] as AddOnElement & {
    count: number;
  };
  expect(element).toMatchObject({ kind: COUNTER_KIND, count: 3 });
  expect(element).not.toHaveProperty('saved');
  expect(kindOf(element).label).toBe('Counter');
  expect(project.addOns).toEqual([{ id: COUNTER_ADD_ON, version: '1.1.0' }]);
  const saved = serializeProject(project) as {
    pages: { elements: Record<string, unknown>[] }[];
  };
  expect(saved.pages[0]!.elements[0]).toMatchObject({ count: 3 });
});

test('an Add-on kind is created with its defaults and Scripts reach its properties', async () => {
  await loaderWith().load([{ id: COUNTER_ADD_ON, version: '1.0.0' }]);
  expect(createAnyElement(COUNTER_KIND, 'tally')).toMatchObject({
    kind: COUNTER_KIND,
    name: 'tally',
    count: 0,
  });
  const { project } = await projectWithAddOns(
    projectWithCounter(),
    loaderWith(),
  );
  const button = createElement('button', 'button1');
  button.script =
    'on click\n  set the count of counter1 to the count of counter1 + 1\nend click\n';
  project.pages[0]!.elements.push(button);
  const play = new PlaySession(project);
  play.send(play.page.elements[1]!, 'click');
  for (let i = 0; i < 100 && play.pump(0n).state === 'sliced'; i++) {
    // Runs until idle.
  }
  expect(play.problems).toEqual([]);
  expect(play.page.elements[0]).toMatchObject({ count: 4 });
  play.stop(0n);
});

test('an Add-on Folio lacks, or a newer version, stays a placeholder with a reason', async () => {
  const loader = loaderWith();
  expect(
    await loader.load([
      { id: COUNTER_ADD_ON, version: '2.0.0' },
      { id: 'https://example.com/unknown', version: '1.0.0' },
      { id: 'https://example.com/pads', version: '1.0.0', code: '', hash: '' },
    ]),
  ).toEqual([
    {
      id: COUNTER_ADD_ON,
      message: 'the Project needs version 2.0.0, and this Folio has 1.1.0',
    },
    {
      id: 'https://example.com/unknown',
      message: 'this Folio has no such Add-on',
    },
    {
      id: 'https://example.com/pads',
      message: 'Add-ons carried in a Project are not loaded yet',
    },
  ]);
});

test('a failed fetch is reported and tried again next time', async () => {
  let attempts = 0;
  const loader = loaderWith(() => {
    attempts++;
    return attempts === 1
      ? Promise.reject(new Error('offline'))
      : Promise.resolve(counter);
  });
  const ref = { id: COUNTER_ADD_ON, version: '1.0.0' };
  expect(await loader.load([ref])).toEqual([
    { id: COUNTER_ADD_ON, message: 'it could not be fetched: offline' },
  ]);
  expect(await loader.load([ref])).toEqual([]);
  expect(await loader.load([ref])).toEqual([]);
  expect(attempts).toBe(2);
});

test("an Add-on kind may not take a built-in kind's name", async () => {
  const clash: AddOnModule = {
    id: 'https://example.com/clash',
    version: '1.0.0',
    kinds: { button: counter.kinds.counter! },
  };
  const loader = new AddOnLoader({
    catalogue: [{ id: clash.id, kinds: [], slug: 'clash', version: '1.0.0' }],
    importer: () => Promise.resolve(clash),
  });
  expect(await loader.load([{ id: clash.id, version: '1.0.0' }])).toEqual([
    { id: clash.id, message: 'another kind is already named button' },
  ]);
});
