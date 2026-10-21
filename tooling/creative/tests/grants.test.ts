import { expect, test } from 'bun:test';
import {
  defineObjectKind,
  newGroup,
  num,
  text,
  type Call,
  type Value,
} from '@northtalk/ts';
import { readManifest } from '../../stack/src/lsp/manifest';
import { canvasGrant } from '../src/grants/canvas';
import { elementsGrant } from '../src/grants/elements';
import { FOLIO_GRANTS, grantDeclarations } from '../src/grants';
import { soundGrant } from '../src/grants/sound';
import { userGrant } from '../src/grants/user';
import { createProject } from '../src/model';
import { scriptManifest } from '../src/script-manifest';
import { SoundBoard } from '../src/sounds';

// Any state at all: these tests only read what each Capability declares.
const inert = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === 'sounds'
        ? new SoundBoard(undefined, () => {})
        : () => {
            throw new Error(`${String(key)} is not part of this test`);
          },
  },
);
// A Host Object to pass where an Operation takes one; its Grant never reads it.
const group = newGroup({ name: 'grants' });
const someObject = group.object(
  defineObjectKind({ name: 'grantsTestObject', props: {} }),
  'object',
  {},
).value;
const call = (scriptName = 'script:1') =>
  ({ scriptName, charge: () => {} }) as unknown as Call<unknown>;

test('every Grant declares exactly what its Capability accepts', () => {
  for (const definition of FOLIO_GRANTS) {
    const grant = definition.grant(inert as never);
    const capability = grant.capability;
    expect(capability.name).toBe(definition.name);
    expect([...grant.ops].sort()).toEqual(
      Object.keys(definition.operations).sort(),
    );
    for (const [name, declared] of Object.entries(definition.operations)) {
      const accepted = capability.operations.get(name)!;
      expect(
        {
          mode: accepted.mode,
          args: [...(accepted.args ?? [])],
          result: accepted.result,
          cost: accepted.cost.fuel,
          errors: (accepted.errors ?? []).map(e => e.code),
          command: accepted.command === true,
          description: accepted.description,
          examples: accepted.examples,
          maxPendingMs:
            accepted.mode === 'suspending' ? accepted.maxPendingMs : undefined,
        },
        `${definition.name}.${name}`,
      ).toEqual({
        mode: declared.mode,
        args: [...(declared.args ?? [])],
        result: declared.result,
        cost: declared.cost.fuel,
        errors: (declared.errors ?? []).map(e => e.code),
        command: declared.command === true,
        description: declared.description,
        examples: declared.examples && [...declared.examples],
        maxPendingMs: declared.maxPendingMs,
      });
    }
  }
});

test("each Script's Manifest lists every Grant as it is declared", () => {
  const project = createProject('Story');
  const manifest = readManifest(scriptManifest(project, project));
  expect([...manifest.grants.keys()]).toEqual(FOLIO_GRANTS.map(g => g.name));
  for (const definition of FOLIO_GRANTS) {
    const operations = manifest.grants.get(definition.name)!;
    expect([...operations.keys()]).toEqual(Object.keys(definition.operations));
    for (const [name, declared] of Object.entries(definition.operations)) {
      const read = operations.get(name)!;
      expect(read.mode, `${definition.name}.${name}`).toBe(declared.mode);
      expect(read.args, `${definition.name}.${name}`).toEqual([
        ...(declared.args ?? []),
      ]);
    }
  }
  const declarations = grantDeclarations();
  for (const definition of FOLIO_GRANTS) {
    expect(Object.keys(declarations[definition.name]!)).toEqual(
      Object.keys(definition.operations),
    );
  }
});

test('the sound Grant plays for the calling Script and stops on release', () => {
  const played: [string, string, boolean][] = [];
  const sounds = new SoundBoard(undefined, () => {});
  const grant = soundGrant.grant({
    sounds,
    play: (owner, name, loop) => played.push([owner, name, loop]),
  });
  const op = (name: string) => grant.capability.operations.get(name)!;
  const fire = (name: string, ...args: Value[]) => {
    const operation = op(name);
    if (operation.mode !== 'fire-and-forget') {
      throw new Error(name);
    }
    operation.fire(call('script:2'), ...args);
  };
  fire('play', text('chime'));
  fire('loop', text('rain'));
  expect(played).toEqual([
    ['script:2', 'chime', false],
    ['script:2', 'rain', true],
  ]);
});

test('the elements Grant refuses unknown kinds and missing Elements', () => {
  const grant = elementsGrant.grant({
    create: () => {
      throw new Error('never reached');
    },
    clone: () => text('copy'),
    find: () => undefined,
    remove: () => {},
  });
  const create = grant.capability.operations.get('create')!;
  const find = grant.capability.operations.get('find')!;
  if (create.mode !== 'immediate' || find.mode !== 'immediate') {
    throw new Error('immediate');
  }
  const page = someObject;
  expect(() => create.do(call(), text('group'), page)).toThrow(
    'Unknown Element kind',
  );
  expect(() => find.do(call(), text('door'), page)).toThrow(
    'Element not found',
  );
});

test('the canvas Grant validates before it draws', () => {
  const drawn: unknown[] = [];
  const draw = (command: unknown) => drawn.push(command);
  const grant = canvasGrant.grant({ drawingOf: () => draw });
  const fill = grant.capability.operations.get('fill')!;
  const circle = grant.capability.operations.get('circle')!;
  if (fill.mode !== 'immediate' || circle.mode !== 'immediate') {
    throw new Error('immediate');
  }
  const canvas = someObject;
  expect(() => fill.do(call(), canvas, text('red'))).toThrow(
    'Colors use #RRGGBB or #RRGGBBAA',
  );
  circle.do(call(), canvas, num(1), num(2), num(3));
  expect(drawn).toEqual([{ op: 'circle', args: ['1', '2', '3'] }]);
});

test('the user Grant takes its declarations from the Core', () => {
  const asked: unknown[] = [];
  const grant = userGrant.grant({
    ask: (_call, prompt) => asked.push(prompt),
    notify: () => {},
  });
  const confirm = grant.capability.operations.get('confirm')!;
  if (confirm.mode !== 'suspending') {
    throw new Error('suspending');
  }
  confirm.start!(call(), text('Open the door?'));
  expect(asked).toEqual([{ kind: 'confirm', message: 'Open the door?' }]);
});
