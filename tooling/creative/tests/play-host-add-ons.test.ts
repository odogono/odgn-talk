// Add-on load gating in PlayHost (#1901, #2270): an `open` whose Project
// lists Add-ons waits for them, and the requests that arrive meanwhile wait
// behind it, in order.
import { expect, test } from 'bun:test';
import type { Envelope, Reply } from '@northtalk/tooling/worker-supervisor';
import { defineAddOn } from '../src/add-ons/api';
import { AddOnLoader, type AddOnProblem } from '../src/add-ons/loader';
import { synthEngine } from '../src/instruments/synth';
import { type AddOnRef, createProject, type Project } from '../src/model';
import { PlayHost } from '../src/play-host';
import type { PlayRequest, PlayResponse, PlayView } from '../src/play-protocol';

const REF: AddOnRef = {
  id: 'https://example.test/add-ons/held',
  version: '1.0.0',
};

const withAddOns = (name: string): Project => {
  const project = createProject(name);
  project.addOns = [REF];
  return project;
};

/** A loader whose loads finish only when the test says. */
const heldLoader = () => {
  const loads: {
    finish(problems?: AddOnProblem[]): void;
    refs: readonly AddOnRef[];
  }[] = [];
  const trusted: ((hash: string) => boolean)[] = [];
  return {
    loads,
    trusted,
    addOns: (isTrusted: (hash: string) => boolean) => {
      trusted.push(isTrusted);
      return {
        load: (refs: readonly AddOnRef[]) =>
          new Promise<AddOnProblem[]>(resolve => {
            loads.push({
              refs,
              finish: (problems = []) => resolve(problems),
            });
          }),
      };
    },
  };
};

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const recording = (addOns?: ReturnType<typeof heldLoader>['addOns']) => {
  const replies: Reply<PlayResponse>[] = [];
  const host = new PlayHost(reply => replies.push(structuredClone(reply)), {
    addOns,
  });
  let id = 1;
  const send = (request: PlayRequest) => {
    const envelope = { id: id++, request } satisfies Envelope<PlayRequest>;
    host.receive(envelope);
    return envelope.id;
  };
  const answered = () =>
    replies.flatMap(reply =>
      reply.response.kind === 'view' ? [] : [reply.id],
    );
  const views = () =>
    replies.flatMap(({ response }) =>
      response.kind === 'view' ? [response] : [],
    );
  return { host, send, answered, views, replies };
};

const open = (session: number, project: Project, trustedAddOns?: string[]) =>
  ({
    kind: 'open',
    session,
    project: structuredClone(project),
    pageIndex: 0,
    seed: 0n,
    trustedAddOns,
  }) satisfies PlayRequest;

test('requests wait while an open’s Add-ons load, then run in order behind it', async () => {
  const loader = heldLoader();
  const { send, answered, views } = recording(loader.addOns);
  const opened = send(open(1, withAddOns('Held'), ['abc']));
  const hushed = send({ kind: 'hush', session: 1 });
  const stopped = send({ kind: 'stop', session: 1 });
  expect(loader.loads.map(load => load.refs)).toEqual([[REF]]);
  // The page's trusted hashes reach the loader before it loads.
  expect(loader.trusted[0]!('abc')).toBe(true);
  expect(loader.trusted[0]!('xyz')).toBe(false);
  await settle();
  expect(answered()).toEqual([]);
  loader.loads[0]!.finish();
  await settle();
  expect(answered()).toEqual([opened, hushed, stopped]);
  // The stop reached the session it was sent for, so the last view ended it.
  expect(views().at(-1)?.ended).toBe(true);
});

test('an open without Add-ons, or a host without a loader, does not wait', () => {
  const loader = heldLoader();
  const plain = recording(loader.addOns);
  const opened = plain.send(open(1, createProject('Plain')));
  expect(plain.answered()).toEqual([opened]);
  expect(loader.loads).toEqual([]);
  const unloaded = recording();
  const listed = unloaded.send(open(1, withAddOns('Listed')));
  expect(unloaded.answered()).toEqual([listed]);
});

test('a second open with Add-ons during the replay holds the requests after it', async () => {
  const loader = heldLoader();
  const { send, answered } = recording(loader.addOns);
  const first = send(open(1, withAddOns('First')));
  const before = send({ kind: 'stop', session: 1 });
  const second = send(open(2, withAddOns('Second')));
  const after = send({ kind: 'hush', session: 2 });
  const last = send({ kind: 'stop', session: 2 });
  loader.loads[0]!.finish();
  await settle();
  // The second open waits for its own Add-ons, with the rest behind it.
  expect(answered()).toEqual([first, before]);
  expect(loader.loads).toHaveLength(2);
  // Requests that arrive now queue behind those already held.
  const later = send({ kind: 'stop', session: 2 });
  loader.loads[1]!.finish();
  await settle();
  expect(answered()).toEqual([first, before, second, after, last, later]);
});

test('an Add-on that fails to load still opens the session', async () => {
  const loader = heldLoader();
  const { send, answered, views } = recording(loader.addOns);
  const opened = send(open(1, withAddOns('Missing')));
  const hushed = send({ kind: 'hush', session: 1 });
  loader.loads[0]!.finish([{ id: REF.id, message: 'it could not be fetched' }]);
  await settle();
  expect(answered()).toEqual([opened, hushed]);
  expect(views().at(-1)?.ended).toBe(false);
});

// #2040: a Project whose Instruments come from an Add-on opened before the
// Add-on loaded, so `bass` was an unknown name. The worker's loader runs
// first, so the session has its Instrument.
test('an Instrument kind from a Project’s Add-on is known when its session opens', async () => {
  const id = 'https://example.test/add-ons/band-2040';
  const module = defineAddOn({
    id,
    version: '1.0.0',
    kinds: {},
    instruments: {
      synth: {
        label: 'Synth',
        instanceName: 'synth',
        kind: ({ operations }) => ({
          ...synthEngine,
          // Its own name: the built-in synth may already be registered.
          name: 'band',
          operations: operations.note,
        }),
      },
    },
  });
  const project = createProject('Band');
  project.addOns = [{ id, version: '1.0.0' }];
  // As a saved Project writes it: the kind isn't registered until it loads.
  project.instruments.push({
    name: 'bass',
    kind: `${id}#synth`,
    voices: 8,
    parameters: {},
  });
  const views: PlayView[] = [];
  const host = new PlayHost(
    sent => {
      const { response } = structuredClone(sent);
      if (response.kind === 'view') {
        views.push(response);
      }
    },
    {
      addOns: trusted =>
        new AddOnLoader({
          trusted,
          catalogue: [
            { id, version: '1.0.0', label: 'Band', slug: 'band', kinds: [] },
          ],
          importer: () => Promise.resolve(module),
        }),
    },
  );
  host.receive({ id: 1, request: open(1, project) });
  host.receive({
    id: 2,
    request: {
      kind: 'message',
      session: 1,
      text: 'put the cutoff of bass into x',
    },
  });
  await settle();
  expect(
    views.filter(view => view.instruments).at(-1)?.instruments?.bass,
  ).toBeDefined();
  expect(views.flatMap(view => view.problems)).toEqual([]);
  host.receive({ id: 3, request: { kind: 'stop', session: 1 } });
});
