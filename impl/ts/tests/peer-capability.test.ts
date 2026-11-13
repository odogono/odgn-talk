import { expect, test } from 'bun:test';
import {
  HostError,
  newGroup,
  nothing,
  parseInstant,
  peerCapability,
  peerKind,
  type GrantContext,
  type HostObject,
  type PeerImpl,
  type Value,
} from '../src/index';

const now = parseInstant('2026-11-02T12:00:00Z');
const costs = {
  expose: { fuel: 5 },
  unexpose: { fuel: 2 },
  reach: { fuel: 4 },
  post: { fuel: 3 },
  call: { fuel: 6 },
  caller: { fuel: 1 },
};
const noPeer: PeerImpl = {
  expose: () => {},
  unexpose: () => {},
  reach: () => {},
  post: () => {},
  call: () => {},
  caller: () => nothing,
};

test('peer validates its Host methods and needs every Operation cost', () => {
  for (const name of Object.keys(costs) as (keyof typeof costs)[]) {
    const { [name]: _, ...rest } = costs;
    expect(() => peerCapability(noPeer, rest)).toThrow(HostError);
    const { [name]: __, ...partial } = noPeer;
    expect(() => peerCapability(partial as unknown as PeerImpl, costs)).toThrow(
      HostError,
    );
  }
  expect([...peerCapability(noPeer, costs).operations.keys()].sort()).toEqual([
    'call',
    'caller',
    'expose',
    'post',
    'reach',
    'unexpose',
  ]);
});

test('Load refuses a Script given two peer Grants', () => {
  const peer = peerCapability(noPeer, costs);
  const g = newGroup({ name: 'g' });
  expect(() =>
    g.load({
      name: 's',
      source: 'on go\nend go',
      grants: { a: peer.grant('all', null), b: peer.grant('all', null) },
    }),
  ).toThrow(HostError);
});

test('a send to a Peer is the Grant post, with the Peer, Selector and arguments', () => {
  const posted: [HostObject, string, Value[]][] = [];
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source: 'on go p\n  send charge with 12, {to: [p]} to p\nend go',
    grants: {
      peer: peerCapability(
        { ...noPeer, post: (_call, p, m, args) => posted.push([p, m, args]) },
        costs,
      ).grant('all', null),
    },
  });
  const billing = g.object(peerKind, 'billing', null);
  s.deliver({ name: 'go', args: [billing.value] });
  g.pump(now);
  expect(posted.map(([p, m, args]) => [p.id, m, args.map(String)])).toEqual([
    ['billing', 'charge', ['12', '{to: [<object peer "billing">]}']],
  ]);
});

test('GrantsAsUsed keeps post and call with reach, and caller with expose', () => {
  const peer = peerCapability(noPeer, costs);
  const g = newGroup({ name: 'g' });
  g.load({
    name: 'shop',
    source: 'on go\n  ask peer to reach "billing" and wait\nend go',
    grants: { peer: peer.grant('all', null) },
    grantsAsUsed: true,
  });
  g.load({
    name: 'billing',
    source: 'on go\n  ask peer to expose "billing" and wait\nend go',
    grants: { peer: peer.grant('all', null) },
    grantsAsUsed: true,
  });
  expect(g.script('shop')!.grants()['peer']!.sort()).toEqual([
    'call',
    'post',
    'reach',
  ]);
  expect(g.script('billing')!.grants()['peer']!.sort()).toEqual([
    'call',
    'caller',
    'expose',
    'post',
  ]);
});

test('peer forwards an optional release hook and needs none', () => {
  expect(peerCapability(noPeer, costs).release).toBeUndefined();
  expect(() =>
    peerCapability({ ...noPeer, release: 1 } as unknown as PeerImpl, costs),
  ).toThrow(HostError);

  const released: [string, string, string][] = [];
  const impl = {
    ...noPeer,
    seen: released,
    release(this: { seen: typeof released }, c: GrantContext<unknown>) {
      this.seen.push([c.scriptName, c.grantName, c.reason]);
    },
  };
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source: 'on go\nend go',
    grants: { net: peerCapability(impl, costs).grant('all', null) },
  });
  s.stop('done');
  g.pump(now);
  expect(released).toEqual([['s', 'net', 'stop']]);
});
