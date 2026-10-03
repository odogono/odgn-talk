import { expect, test } from 'bun:test';
import { createReplayHost, replayTrace, type Setup } from '../src/replay';

const clock = '2026-10-02T00:00:00Z';
const setup: Setup = {
  operations: [
    {
      capability: 'remote',
      name: 'get',
      mode: 'suspending',
      args: [],
      result: 'number',
    },
  ],
  scripts: [
    {
      name: 's',
      source: 's.talk',
      text: 'script variable x = 0\non go\nask remote to get and wait\nput it into x\nend go',
      grants: { remote: { ops: 'all' } },
    },
  ],
};

test('incremental Host resolves calls discovered by a previous Pump and matches concrete replay', () => {
  const host = createReplayHost(() => {
    throw new Error('inline sources only');
  }, setup);
  host.apply('> load s');
  host.apply('> deliver to=s message=go');
  host.apply(`> pump clock=${clock}`);
  expect(host.callIds).toEqual(['s/r1.c1']);
  host.apply(`> answer ${host.callIds[0]} value=42`);
  host.apply(`> pump clock=${clock}`);
  host.apply('> vars');
  expect(host.trace).toContain('vars s x=42');
  const step = replayTrace(() => '', setup, host.trace);
  let next = step.next();
  while (!next.done) {
    next = step.next();
  }
  expect(next.value).toEqual(host.trace);
});

test('incremental Host keeps the restored Group and rebound pending Call handles', () => {
  const host = createReplayHost(() => '', setup);
  host.apply('> load s');
  host.apply('> deliver to=s message=go');
  host.apply(`> pump clock=${clock}`);
  const before = host.group;
  host.apply('> save');
  expect(host.saveIds).toEqual(['s1']);
  host.apply('> restore from=s1');
  expect(host.group).not.toBe(before);
  host.apply('> settle s/r1.c1 how=adopt');
  host.apply('> answer s/r1.c1 value=7');
  host.apply(`> pump clock=${clock}`);
  host.apply('> vars');
  expect(host.trace).toContain('vars s x=7');
});
