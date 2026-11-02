import { expect, test } from 'bun:test';
import {
  HostError,
  newGroup,
  nothing,
  parseInstant,
  peerCapability,
  peerKind,
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
