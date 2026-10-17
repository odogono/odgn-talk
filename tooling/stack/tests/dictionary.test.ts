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

test('the Playground dictionary model retains plain descriptions and source examples', () => {
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
