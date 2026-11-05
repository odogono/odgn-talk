// The peer router over an in-memory pair of links (ADR 0165), shared by the
// Bun test and the CLI's Node runtime check so it runs under both.
import assert from 'node:assert/strict';
import { newDrivenGroup } from '../src/driver';
import {
  consoleCapability,
  encodeValue,
  map,
  newGroup,
  peerCapability,
  text,
  type Value,
} from '../src/index';
import {
  fingerprintOf,
  PeerRouter,
  type PeerLink,
  type PeerLinkEvents,
} from '../src/peer';

const costs = {
  expose: { fuel: 0 },
  unexpose: { fuel: 0 },
  reach: { fuel: 0 },
  post: { fuel: 0 },
  call: { fuel: 0 },
  caller: { fuel: 0 },
};

/** One end of an in-memory link: frames cross as text, a turn later. */
class MemoryLink implements PeerLink {
  other!: MemoryLink;
  closed = false;
  /** Drops the calls that arrive, as a Host that never answers them. */
  deaf = false;
  private events: PeerLinkEvents | undefined;
  readonly sent: string[] = [];

  constructor(
    readonly key: string,
    readonly identity: Value,
  ) {}

  open(events: PeerLinkEvents) {
    this.events = events;
  }

  send(frame: string): boolean {
    if (this.closed) {
      return false;
    }
    this.sent.push(frame);
    queueMicrotask(() => {
      if (!(this.other.deaf && frame.startsWith('{"call"'))) {
        this.other.events?.frame(frame);
      }
    });
    return true;
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.events?.close();
    this.other.close();
  }
}

/** Two linked ends: `a` is the link to `bKey`, held by the Host with `aKey`. */
const linkPair = (aKey: string, bKey: string): [MemoryLink, MemoryLink] => {
  const a = new MemoryLink(
    bKey,
    map([
      ['key', text(bKey)],
      ['via', text('memory')],
    ]),
  );
  const b = new MemoryLink(
    aKey,
    map([
      ['key', text(aKey)],
      ['via', text('memory')],
    ]),
  );
  a.other = b;
  b.other = a;
  return [a, b];
};

const billingSource = [
  'on go',
  '  ask peer to expose "billing" and wait',
  'end go',
  'on charge amount',
  '  if amount > 100 then',
  '    throw {code: "too much"}',
  '  end if',
  '  ask peer to caller',
  '  return [amount + 1, it]',
  'end charge',
  'on note line',
  '  ask peer to caller',
  '  say line & " from " & the via of it',
  'end note',
  '',
].join('\n');

const shopSource = [
  'on go',
  '  ask peer to reach "billing" into billing and wait',
  '  send charge with 12 to billing into total and wait',
  '  send note with "hi" to billing',
  '  try',
  '    send charge with 500 to billing and wait',
  '  catch e',
  '    return [total, the reason of e, the code of the error of e]',
  '  end try',
  'end go',
  'on later',
  '  ask peer to reach "billing" into billing and wait',
  '  try',
  '    send charge with 1 to billing and wait',
  '  catch e',
  '    return the reason of e',
  '  end try',
  'end later',
  '',
].join('\n');

/**
 * Two Hosts' routers carry a `reach`, a `call` and its reply with the Caller
 * Identity the link vouches for, a Script error as `send failed`, and a
 * `post`. A link that closes fails what waits on it as `unreachable`.
 */
export const verifyPeerRouter = async (): Promise<void> => {
  // A router made without a key makes one with WebCrypto.
  const made = await PeerRouter.create(newGroup({ name: 'spare' }));
  assert.match(made.key, /^[\da-f]{64}$/);
  assert.equal(
    await fingerprintOf(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );

  const shopKey = 'a'.repeat(64);
  const billingKey = 'b'.repeat(64);
  const said: string[] = [];
  const core = { newGroup };
  const { group: billingGroup, drive: billingDrive } = newDrivenGroup(core, {
    name: 'billing',
  });
  const { group: shopGroup, drive: shopDrive } = newDrivenGroup(core, {
    name: 'shop',
  });
  const drives = [billingDrive, shopDrive];

  let link: [MemoryLink, MemoryLink] | undefined;
  const billingRouter = await PeerRouter.create(billingGroup, {
    key: billingKey,
  });
  const shopRouter = await PeerRouter.create(shopGroup, {
    key: shopKey,
    dial: async address => {
      if (address !== 'billing') {
        return undefined;
      }
      if (!link || link[0].closed) {
        link = linkPair(shopKey, billingKey);
        billingRouter.connect(link[1]);
      }
      return link[0];
    },
  });
  const console = consoleCapability(
    {
      write: (_call, value) => void said.push(value.asText() ?? ''),
      read: () => {},
    },
    { write: { fuel: 0 }, read: { fuel: 0 } },
  );
  const grant = (router: PeerRouter) => ({
    console: console.grant('all', null),
    peer: peerCapability(router.impl, costs).grant('all', null),
  });
  const billing = billingGroup.load({
    name: 'billing',
    source: billingSource,
    grants: grant(billingRouter),
  });
  const shop = shopGroup.load({
    name: 'shop',
    source: shopSource,
    grants: grant(shopRouter),
  });
  try {
    await billing.request({ name: 'go', args: [] }).result;
    const result = await shop.request({ name: 'go', args: [] }).result;
    assert.equal(
      encodeValue(result),
      `[[13,{"key":"${shopKey}","via":"memory"}],"errored","too much"]`,
    );
    // Every frame crosses as the Value Encoding's JSON text.
    assert.deepEqual(
      link![0].sent.map(f => Object.keys(JSON.parse(f) as object)[0]),
      ['reach', 'call', 'post', 'call'],
    );

    assert.deepEqual(said, ['hi from memory']);

    // A link that closes with a call on it fails the call as unreachable:
    // billing's end never answers the call, then closes.
    link![1].deaf = true;
    const sent = link![0].sent.length;
    const waiting = shop.request({ name: 'later', args: [] });
    for (let i = 0; i < 1000 && link![0].sent.length < sent + 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    link![1].close();
    assert.equal((await waiting.result).asText(), 'unreachable');
  } finally {
    await Promise.all(drives.map(d => d.close()));
  }
};
