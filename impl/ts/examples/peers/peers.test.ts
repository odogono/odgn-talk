// Two Groups on one Host, talking only through the peer router: the round
// trip the Conformance Corpus leaves out (#1974).
import { expect, test } from 'bun:test';
import {
  map,
  newGroup,
  num,
  parseInstant,
  peerCapability,
  text,
  type TsGroup,
  type Value,
} from '@northtalk/ts';
import { PeerRouter, type PeerBinding } from './router';

const costs = {
  expose: { fuel: 5 },
  unexpose: { fuel: 2 },
  reach: { fuel: 4 },
  post: { fuel: 3 },
  call: { fuel: 6 },
  caller: { fuel: 1 },
};

const billingSource = `script variable seen = []
on start
  ask peer to expose "billing" and wait
end start
on charge amount
  ask peer to caller
  put [amount, it] after seen
  if amount > 100 then
    throw {code: "too much", limit: 100}
  end if
  return amount + 1
end charge
on note line, claim
  ask peer to caller
  put [line, it] after seen
end note
on subscribe inbox
  send said with "subscribed" to inbox
end subscribe
on close
  ask peer to unexpose "billing"
end close`;

const shopSource = `script variable got = []
script variable billing = nothing
on start
  ask peer to reach "billing" into billing and wait
end start
on pay amount
  try
    send charge with amount to billing and wait
    put it after got
  catch e
    put [the code of e, the reason of e] after got
  end try
end pay
on note line
  send note with line, {user: "mallory"} to billing
end note
on listen
  ask peer to expose into inbox and wait
  send subscribe with inbox to billing
end listen
on said line
  put line after got
end said
on reachAgain
  try
    ask peer to reach "billing" and wait
  catch e
    put the code of e after got
  end try
end reachAgain
on forbidden
  try
    ask peer to reach "admin" and wait
  catch e
    put the code of e after got
  end try
end forbidden`;

let clock = parseInstant('2026-11-02T12:00:00Z');
// Each Pump runs its Group, then the microtasks that carry replies across.
const settle = async (...groups: TsGroup[]) => {
  for (let i = 0; i < 4; i++) {
    for (const g of groups) {
      clock += 1000n;
      g.pump(clock);
    }
    await new Promise(r => setTimeout(r, 0));
  }
};
const vars = (g: TsGroup, script: string): Map<string, Value> =>
  new Map(g.inspect().scripts.find(s => s.name === script)!.vars);

const setUp = () => {
  const router = new PeerRouter();
  const peer = peerCapability(router.impl, costs);
  const billing = newGroup({ name: 'billing' });
  const shop = newGroup({ name: 'shop' });
  router.attach(billing, map([['group', text('billing')]]));
  router.attach(shop, map([['group', text('shop')]]));
  const binding: PeerBinding = { expose: ['billing'], reach: ['billing'] };
  const b = billing.load({
    name: 'billing',
    source: billingSource,
    grants: { peer: peer.grant('all', binding) },
  });
  const s = shop.load({
    name: 'shop',
    source: shopSource,
    grants: { peer: peer.grant('all', binding) },
  });
  return { b, billing, s, shop };
};

test('a call crosses to the Exposed Script and its reply comes back', async () => {
  const { b, billing, s, shop } = setUp();
  b.deliver({ name: 'start' });
  await settle(billing);
  s.deliver({ name: 'start' });
  await settle(shop);
  s.deliver({ name: 'pay', args: [num(12)] });
  s.deliver({ name: 'pay', args: [num(500)] });
  await settle(shop, billing);
  expect(String(vars(shop, 'shop').get('got'))).toBe(
    '[13, ["send failed", "errored"]]',
  );
  // The receiving Host vouched for the sender's Group, never its arguments.
  expect(String(vars(billing, 'billing').get('seen'))).toBe(
    '[[12, {group: "shop"}], [500, {group: "shop"}]]',
  );
});

test('a post carries no reply, and the identity is still the Host’s', async () => {
  const { b, billing, s, shop } = setUp();
  b.deliver({ name: 'start' });
  await settle(billing);
  s.deliver({ name: 'start' });
  await settle(shop);
  s.deliver({ name: 'note', args: [text('hello')] });
  await settle(shop, billing);
  expect(String(vars(billing, 'billing').get('seen'))).toBe(
    '[["hello", {group: "shop"}]]',
  );
});

test('a Peer handed over in a Remote Send is a push channel back', async () => {
  const { b, billing, s, shop } = setUp();
  b.deliver({ name: 'start' });
  await settle(billing);
  s.deliver({ name: 'start' });
  s.deliver({ name: 'listen' });
  await settle(shop, billing);
  expect(String(vars(shop, 'shop').get('got'))).toBe('["subscribed"]');
});

test('the binding refuses a name, and an unexposed name is not exposed', async () => {
  const { b, billing, s, shop } = setUp();
  b.deliver({ name: 'start' });
  await settle(billing);
  s.deliver({ name: 'start' });
  s.deliver({ name: 'forbidden' });
  await settle(shop);
  b.deliver({ name: 'close' });
  await settle(billing);
  s.deliver({ name: 'reachAgain' });
  s.deliver({ name: 'pay', args: [num(1)] });
  await settle(shop, billing);
  expect(String(vars(shop, 'shop').get('got'))).toBe(
    '["bad address", "not exposed", ["send failed", "not exposed"]]',
  );
});
