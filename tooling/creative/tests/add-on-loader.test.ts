// Loading built-in Add-ons and registering their kinds (ADR 0162, #1901).
import { expect, test } from 'bun:test';
import {
  AddOnLoader,
  compareVersions,
  NOT_TRUSTED,
} from '../src/add-ons/loader';
import { TrustStore } from '../src/add-ons/trust';
import { projectWithAddOns } from '../src/add-ons/project';
import type { AddOnModule } from '../src/add-ons/api';
import type { CatalogueEntry } from '../src/add-ons/catalogue';
import {
  createAnyElement,
  isPlaceholderKind,
  kindOf,
} from '../src/elements/registry';
import { createElement, createProject, type AddOnElement } from '../src/model';
import { PlaySession } from '../src/play';
import {
  serializeProject,
  sha256Hex,
  validateProjectJson,
} from '../src/project-file';
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
      message: NOT_TRUSTED,
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

// A Project Add-on as a `.folio` file carries it: built JavaScript.
const PADS = 'https://example.com/pads';
const PADS_CODE = `export default {
  id: '${PADS}',
  version: '0.1.0',
  kinds: {
    pad: {
      data: ({ commonProperties, property }) => ({
        label: 'Pad',
        icon: '▢',
        creatable: true,
        properties: { ...commonProperties, hits: property('hits', 'number') },
        create: base => ({ ...base, hits: 0 }),
        check: (c, e, path, { base }) => ({
          ...base(),
          hits: c.num(e.hits, path + '.hits', 'finite') ?? 0,
        }),
      }),
    },
  },
};`;

const padsRef = async (code = PADS_CODE) => ({
  id: PADS,
  version: '0.1.0',
  code,
  hash: await sha256Hex(new TextEncoder().encode(code)),
});

test('a Project Add-on runs only once its code is trusted, by hash', async () => {
  const ref = await padsRef();
  const trusted = new Set<string>();
  const loader = new AddOnLoader({ trusted: hash => trusted.has(hash) });
  expect(await loader.load([ref])).toEqual([
    { id: PADS, message: NOT_TRUSTED },
  ]);
  expect(isPlaceholderKind(`${PADS}#pad`)).toBe(true);
  trusted.add(ref.hash);
  expect(await loader.load([ref])).toEqual([]);
  expect(createAnyElement(`${PADS}#pad`, 'pad1')).toMatchObject({
    kind: `${PADS}#pad`,
    hits: 0,
  });
  // Changed code has another hash, so it asks again.
  const changed = await padsRef(`${PADS_CODE}\n// changed`);
  expect(await loader.load([changed])).toEqual([
    { id: PADS, message: NOT_TRUSTED },
  ]);
});

test('a Project Add-on must be the Add-on the Project names', async () => {
  const ref = { ...(await padsRef()), version: '0.2.0' };
  const loader = new AddOnLoader({ trusted: () => true });
  expect(await loader.load([ref])).toEqual([
    { id: PADS, message: `its module is ${PADS} 0.1.0` },
  ]);
  const broken = await padsRef('export default {');
  expect((await loader.load([broken]))[0]!.message).toStartWith(
    'its code failed to load',
  );
});

test('trust is remembered in browser storage, and survives storage failing', () => {
  const items = new Map<string, string>();
  const storage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => items.set(k, v),
  } as unknown as Storage;
  new TrustStore(storage).trust(['abc']);
  expect(new TrustStore(storage).has('abc')).toBe(true);
  const failing = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  } as unknown as Storage;
  const store = new TrustStore(failing);
  store.trust(['def']);
  expect(store.has('def')).toBe(true);
});
