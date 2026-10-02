import { expect, test } from 'bun:test';
import {
  compileLibrary,
  coreVersions,
  defineCapability,
  defineObjectKind,
  exportManifest,
  num,
  shape,
  type ManifestSpec,
} from '../src/index';

const fail = () => {
  throw new Error('Host callbacks must not run');
};

test('an empty Host Manifest has the chapter 9 fields in fixed order', () => {
  expect(exportManifest({ kind: 'NPC', version: '1', grants: {} })).toBe(
    `{"kind":"NPC","version":"1","language":"${coreVersions.language}","grants":[],"libraries":[],"messages":[],"objectKinds":[],"objects":[]}\n`,
  );
});

test('declaration ordering uses code points, including supplementary names', () => {
  const capability = defineCapability('unicode-manifest', {
    '𐀀': { mode: 'immediate', cost: { fuel: 0 }, do: () => num(1) },
    '\uE000': { mode: 'immediate', cost: { fuel: 0 }, do: () => num(2) },
  });
  const data = JSON.parse(
    exportManifest({
      kind: 'unicode',
      version: '1',
      grants: {
        '𐀀': capability.grant('all', undefined),
        '\uE000': capability.grant('all', undefined),
      },
    }),
  );
  expect(data.grants.map((g: { name: string }) => g.name)).toEqual([
    '\uE000',
    '𐀀',
  ]);
  expect(
    data.grants[0].operations.map((op: { name: string }) => op.name),
  ).toEqual(['\uE000', '𐀀']);
});

test('Host Manifests sort declarations, preserve Shape order and omit executable and native state', () => {
  const actor = defineObjectKind({
    name: 'actor',
    parentKinds: ['zone', 'scene'],
    props: {
      z: {
        get: fail,
        set: fail,
        shape: shape.text,
        getCost: { fuel: 2 },
        setCost: { fuel: 3, alloc: 4 },
      },
      a: { get: fail },
    },
  });
  const zone = defineObjectKind({ name: 'zone', props: {} });
  const capability = defineCapability<{ secret: string }>('service', {
    z: {
      mode: 'suspending',
      args: [shape.optional(shape.object(actor))],
      result: shape.listOf(shape.oneOf(shape.text, shape.number)),
      cost: { fuel: 5 },
      maxPendingMs: 20,
      errors: [
        {
          code: 'z',
          fields: { detail: { optional: true, shape: shape.bytes } },
        },
        { code: 'a' },
      ],
      start: fail,
    },
    a: {
      mode: 'immediate',
      args: [
        shape.openMap({
          z: shape.quantityOf('GBP'),
          a: { optional: true, shape: shape.quantityKind('currency') },
        }),
      ],
      result: shape.value,
      cost: { fuel: 1, alloc: 2 },
      do: fail,
    },
    hidden: { mode: 'immediate', cost: { fuel: 0 }, do: () => num(1) },
  });
  const library = compileLibrary(
    {
      name: 'helpers',
      version: '2',
      source: 'on log\n  tell console to write "hi"\nend log',
    },
    [],
    { console: { write: { mode: 'fire-and-forget', args: [shape.value] } } },
  );
  const manifest: ManifestSpec = {
    kind: 'game NPC',
    version: '3',
    grants: {
      z: capability.grant(['z'], { secret: 'native-secret' }),
      a: capability.grant(['z', 'a'], { secret: 'other-secret' }),
    },
    libraries: [library],
    messages: [
      { name: 'z', args: [shape.any], receivers: [zone, actor] },
      { name: 'a' },
    ],
    objectKinds: [zone, actor],
    objects: { z: zone, a: actor },
  };
  const bytes = exportManifest(manifest);
  const data = JSON.parse(bytes);
  expect(Object.keys(data)).toEqual([
    'kind',
    'version',
    'language',
    'grants',
    'libraries',
    'messages',
    'objectKinds',
    'objects',
  ]);
  expect(data.grants).toEqual([
    {
      name: 'a',
      capability: 'service',
      operations: [
        {
          name: 'a',
          mode: 'immediate',
          args: [
            {
              map: [
                { key: 'z', shape: { quantity: 'GBP' } },
                { key: 'a', shape: { unitKind: 'currency' }, optional: true },
              ],
              open: true,
            },
          ],
          result: 'value',
          cost: { fuel: 1, alloc: 2 },
        },
        {
          name: 'z',
          mode: 'suspending',
          args: [{ optional: { object: 'actor' } }],
          result: { list: { oneOf: ['text', 'number'] } },
          cost: { fuel: 5, alloc: 0 },
          maxPending: 20,
          errors: [
            { code: 'a', fields: [] },
            {
              code: 'z',
              fields: [{ key: 'detail', shape: 'bytes', optional: true }],
            },
          ],
        },
      ],
    },
    {
      name: 'z',
      capability: 'service',
      operations: [data.grants[0].operations[1]],
    },
  ]);
  expect(data.libraries).toEqual([
    {
      name: 'helpers',
      version: '2',
      source: library.source,
      needs: [{ capability: 'console', operation: 'write' }],
    },
  ]);
  expect(data.messages).toEqual([
    { name: 'a', args: [], receivers: [] },
    { name: 'z', args: ['any'], receivers: ['actor', 'zone'] },
  ]);
  expect(data.objectKinds).toEqual([
    {
      name: 'actor',
      props: [
        {
          name: 'a',
          shape: 'value',
          readOnly: true,
          getCost: { fuel: 0, alloc: 0 },
          setCost: { fuel: 0, alloc: 0 },
        },
        {
          name: 'z',
          shape: 'text',
          readOnly: false,
          getCost: { fuel: 2, alloc: 0 },
          setCost: { fuel: 3, alloc: 4 },
        },
      ],
      parentKinds: ['scene', 'zone'],
    },
    { name: 'zone', props: [], parentKinds: [] },
  ]);
  expect(data.objects).toEqual([
    { name: 'a', kind: 'actor' },
    { name: 'z', kind: 'zone' },
  ]);
  expect(bytes).not.toContain('secret');
  expect(bytes).not.toContain('hidden');
  expect(
    exportManifest({
      ...manifest,
      grants: {
        a: capability.grant(['a', 'z'], { secret: 'changed' }),
        z: manifest.grants.z!,
      },
      messages: [...manifest.messages!].reverse(),
      objectKinds: [...manifest.objectKinds!].reverse(),
      objects: { a: actor, z: zone },
    }),
  ).toBe(bytes);
  expect(manifest.messages![0]!.name).toBe('z');
  expect(actor.parentKinds).toEqual(['zone', 'scene']);
});
