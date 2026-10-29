import { expect, test } from 'bun:test';
import { coreVersions } from '@northtalk/ts';
import { readDictionary } from '../src/dictionary';
import { readManifest } from '../src/lsp/manifest';

const manifest = (documentation: object) => ({
  kind: 'test',
  version: '1',
  language: coreVersions.language,
  grants: [
    {
      name: 'api',
      capability: 'api',
      operations: [
        {
          name: 'read',
          mode: 'immediate',
          args: [],
          ...documentation,
        },
      ],
    },
  ],
  libraries: [],
  messages: [],
  objects: [],
});

test('the dictionary model retains plain descriptions and source examples', () => {
  const description = '<b>Plain *text*</b>';
  const examples = ['ask api to read', 'not parsed'];
  expect(
    readDictionary(manifest({ description, examples }))[0]!.operations[0],
  ).toMatchObject({
    description,
    examples,
  });
  expect(
    readDictionary(manifest({ description: '', examples: [] }))[0]!
      .operations[0],
  ).toMatchObject({
    description: '',
    examples: [],
  });
});

test('manifest readers reject malformed Operation documentation', () => {
  for (const documentation of [
    { description: null },
    { description: 1 },
    { examples: null },
    { examples: 'source' },
    { examples: [null] },
    { examples: [1] },
  ]) {
    expect(() => readManifest(manifest(documentation))).toThrow();
    expect(readDictionary(manifest(documentation))).toEqual([]);
  }
});

test('an Operation that declares labels is written as its labelled call', () => {
  const [move, place] = readDictionary({
    ...manifest({}),
    grants: [
      {
        name: 'world',
        capability: 'world',
        operations: [
          {
            name: 'move',
            mode: 'suspending',
            args: ['text', 'text'],
            labels: ['to'],
            command: true,
          },
          {
            name: 'place',
            mode: 'fire-and-forget',
            args: ['text', { optional: 'number' }],
            labels: ['at'],
          },
        ],
      },
    ],
  })[0]!.operations;
  expect(move!.call).toBe('ask world to move ‹text› to ‹text› and wait');
  expect(move!.facts).toContain(
    'Host Command: also callable as `move` alone, or as `move ‹text› to ‹text›`',
  );
  expect(place!.call).toBe('tell world to place ‹text› [at ‹number›]');
  expect(() =>
    readManifest({
      ...manifest({}),
      grants: [
        {
          name: 'world',
          capability: 'world',
          operations: [{ name: 'move', mode: 'immediate', labels: 'to' }],
        },
      ],
    }),
  ).toThrow();
});
