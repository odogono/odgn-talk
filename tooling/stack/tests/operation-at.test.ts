import { expect, test } from 'bun:test';
import { coreVersions } from '@northtalk/ts';
import { operationAt } from '../src/lsp/features';
import { readManifest } from '../src/lsp/manifest';

const manifest = readManifest({
  kind: 'test',
  version: '1',
  language: coreVersions.language,
  grants: [
    {
      name: 'api',
      capability: 'api',
      operations: [
        { name: 'read', mode: 'immediate', args: [] },
        { name: 'log', mode: 'fire-and-forget', args: ['text'] },
        {
          name: 'hide',
          mode: 'fire-and-forget',
          args: ['any'],
          command: true,
        },
      ],
    },
  ],
  libraries: [],
  messages: [],
  objects: [],
});

// `|` marks the offset.
const at = (source: string) =>
  operationAt(source.replace('|', ''), source.indexOf('|'), manifest);

test('finds the Operation an ask, a tell and a tell block line call', () => {
  expect(at('on click\n  ask api to re|ad\nend click\n')).toEqual({
    grant: 'api',
    operation: 'read',
  });
  expect(at('on click\n  tell api to log "x"|\nend click\n')).toEqual({
    grant: 'api',
    operation: 'log',
  });
  expect(
    at('on click\n  tell api\n    lo|g "x"\n  end tell\nend click\n'),
  ).toEqual({ grant: 'api', operation: 'log' });
});

test('finds a Grant alone, and a Host Command by name', () => {
  expect(at('on click\n  ask a|pi to nothing\nend click\n')).toEqual({
    grant: 'api',
  });
  expect(at('on click\n  hi|de button1\nend click\n')).toEqual({
    grant: 'api',
    operation: 'hide',
  });
});

test('finds nothing away from a call', () => {
  expect(at('on click\n  put 1 in|to x\nend click\n')).toBeUndefined();
  expect(at('on click\n  ask other to re|ad\nend click\n')).toBeUndefined();
});
