// The peer router over an in-memory pair of links (ADR 0165), shared by the
// Bun test and the CLI's Node runtime check so it runs under both.
import assert from 'node:assert/strict';
import { newDrivenGroup } from '../src/driver';
import {
  consoleCapability,
  defineObjectKind,
  encodeValue,
  map,
  newGroup,
  peerCapability,
  text,
  type HostObject,
  type ReleaseReason,
  type Script,
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

  await verifyRejectedDials();
  await verifyExposureLifetime();
};

const redialSource = [
  'on find address',
  '  try',
  '    ask peer to reach address into found and wait',
  '    return found',
  '  catch e',
  '    return the code of e',
  '  end try',
  'end find',
  'on charge billing',
  '  try',
  '    send charge with 1 to billing and wait',
  '  catch e',
  '    return [the code of e, the reason of e]',
  '  end try',
  'end charge',
  'on note billing',
  '  send note with "lost" to billing',
  '  return "sent"',
  'end note',
  '',
].join('\n');

/** Settles with `promise`, or rejects once `ms` pass, so a Script's MaxWait can't pass for success. */
const within = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not finish in 2s`)),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A `dial` that rejects fails what waits on it as an absent link does: `reach`
 * as `bad address`, a waiting send to a retained Peer as `send failed` with
 * reason `unreachable`, and a `post` quietly, with no unhandled rejection and
 * no frame sent.
 */
const verifyRejectedDials = async (): Promise<void> => {
  const shopKey = 'c'.repeat(64);
  const billingKey = 'd'.repeat(64);
  const core = { newGroup };
  const { group: billingGroup, drive: billingDrive } = newDrivenGroup(core, {
    name: 'billing',
  });
  const { group: shopGroup, drive: shopDrive } = newDrivenGroup(core, {
    name: 'shop',
  });
  const drives = [billingDrive, shopDrive];

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  let link: [MemoryLink, MemoryLink] | undefined;
  let refuse = false;
  const dialled: string[] = [];
  const billingRouter = await PeerRouter.create(billingGroup, {
    key: billingKey,
  });
  const shopRouter = await PeerRouter.create(shopGroup, {
    key: shopKey,
    addressOf: key => (key === billingKey ? 'billing' : undefined),
    dial: async address => {
      dialled.push(address);
      if (refuse || address !== 'billing') {
        throw new Error(`refused ${address}`);
      }
      link = linkPair(shopKey, billingKey);
      billingRouter.connect(link[1]);
      return link[0];
    },
  });
  const grant = (router: PeerRouter) => ({
    peer: peerCapability(router.impl, costs).grant('all', null),
  });
  const billing = billingGroup.load({
    name: 'billing',
    source: billingSource,
    grants: {
      ...grant(billingRouter),
      console: consoleCapability(
        { write: () => {}, read: () => {} },
        { write: { fuel: 0 }, read: { fuel: 0 } },
      ).grant('all', null),
    },
  });
  const shop = shopGroup.load({
    name: 'shop',
    source: redialSource,
    grants: grant(shopRouter),
  });
  const ask = (name: string, arg: Value) =>
    within(shop.request({ name, args: [arg] }).result, name);
  try {
    await billing.request({ name: 'go', args: [] }).result;

    // A `reach` with no open link to its address dials, and the dial rejects.
    assert.equal(
      (await ask('find', text('elsewhere'))).asText(),
      'bad address',
    );
    assert.deepEqual(dialled, ['elsewhere']);

    // A Peer retained past its link's close redials by Host key, and that
    // dial rejects: no frame goes anywhere.
    const peer = await ask('find', text('billing'));
    assert.equal(peer.kind, 'object');
    const [shopEnd] = link!;
    const sent = shopEnd.sent.length;
    shopEnd.close();
    refuse = true;
    assert.equal(
      encodeValue(await ask('charge', peer)),
      '["send failed","unreachable"]',
    );
    assert.equal((await ask('note', peer)).asText(), 'sent');
    // Unhandled rejections are reported after the turn they happen in.
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.deepEqual(dialled, ['elsewhere', 'billing', 'billing', 'billing']);
    assert.equal(shopEnd.sent.length, sent);
    assert.equal(link![0], shopEnd);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    shopRouter.close();
    billingRouter.close();
    await Promise.all(drives.map(d => d.close()));
  }
};

// An Exposed Script that `open`s a named exposure through the Grant `grant`,
// `share`s a new unnamed one, and answers `charge`, `note` and `hold`, whose
// `say "revoke"` has the Host revoke its `peer` Grant mid-Run.
const exposedSource = (grant: string) =>
  [
    'on open name',
    `  ask ${grant} to expose name into p and wait`,
    '  return p',
    'end open',
    'on share',
    `  ask ${grant} to expose into p and wait`,
    '  return p',
    'end share',
    'on claim name',
    '  try',
    `    ask ${grant} to expose name and wait`,
    '    return "claimed"',
    '  catch e',
    '    return the code of e',
    '  end try',
    'end claim',
    'on close name',
    `  ask ${grant} to unexpose name`,
    '  return "closed"',
    'end close',
    'on charge amount',
    '  return amount + 1',
    'end charge',
    'on note line',
    '  say line',
    'end note',
    'on hold amount',
    '  say "revoke"',
    '  return amount + 1',
    'end hold',
    '',
  ].join('\n');

/** A Request's result: a Peer as itself, anything else as its encoding. */
const run = async (script: Script, name: string, arg?: Value) => {
  const result = await within(
    script.request({ name, args: arg === undefined ? [] : [arg] }).result,
    `${script.name} ${name}`,
  );
  return result.kind === 'object' ? result : encodeValue(result);
};

const senderSource = [
  'on find address',
  '  try',
  '    ask peer to reach address into found and wait',
  '    return found',
  '  catch e',
  '    return the code of e',
  '  end try',
  'end find',
  'on share billing',
  '  send share to billing into p and wait',
  '  return p',
  'end share',
  'on charge billing',
  '  try',
  '    send charge with 1 to billing into total and wait',
  '    return total',
  '  catch e',
  '    return [the code of e, the reason of e]',
  '  end try',
  'end charge',
  'on hold billing',
  '  send hold with 1 to billing into total and wait',
  '  return total',
  'end hold',
  'on note billing',
  '  send note with "late" to billing',
  '  return "sent"',
  'end note',
  '',
].join('\n');

/**
 * An exposure ends with its owner (chapter 7, `peer` Lifetime): a Stop, the
 * owner Object's disposal, and the revocation or disabling of the Grant that
 * made it withdraw it, named and unnamed alike, and free its name. A Reload,
 * rejected or not, an Extend, another owner's lifecycle and a Remote Send
 * already delivered are untouched.
 */
const verifyExposureLifetime = async (): Promise<void> => {
  const shopKey = 'e'.repeat(64);
  const billingKey = 'f'.repeat(64);
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
    dial: async () => {
      if (!link || link[0].closed) {
        link = linkPair(shopKey, billingKey);
        billingRouter.connect(link[1]);
      }
      return link[0];
    },
  });
  const said: string[] = [];
  const console = consoleCapability(
    {
      write: (call, value) => {
        if (value.asText() === 'revoke') {
          billingGroup.script(call.scriptName)!.revoke('peer');
        } else {
          said.push(`${call.scriptName}: ${value.asText()}`);
        }
      },
      read: () => {},
    },
    { write: { fuel: 0 }, read: { fuel: 0 } },
  );
  const billingPeer = peerCapability(billingRouter.impl, costs);
  const load = (name: string, o: { grant?: string; owner?: HostObject } = {}) =>
    billingGroup.load({
      name,
      source: exposedSource(o.grant ?? 'peer'),
      grants: {
        console: console.grant('all', null),
        [o.grant ?? 'peer']: billingPeer.grant('all', null),
      },
      ...(o.owner ? { owner: o.owner } : {}),
    });
  const shop = shopGroup.load({
    name: 'shop',
    source: senderSource,
    grants: { peer: peerCapability(shopRouter.impl, costs).grant('all', null) },
  });
  const find = (address: string) => run(shop, 'find', text(address));
  const charge = (peer: Value | string) => run(shop, 'charge', peer as Value);
  const settled = async () => {
    for (let i = 0; i < 5; i++) {
      await billingDrive.idle();
      await shopDrive.idle();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  };
  const notExposed = '["send failed","not exposed"]';
  const release = (scriptName: string, grantName: string, reason: string) =>
    billingRouter.impl.release!({
      binding: null,
      grantName,
      group: billingGroup,
      now: 0n,
      reason: reason as ReleaseReason,
      scriptName,
    });

  try {
    // Stop withdraws named and unnamed exposures; another Script's stays.
    const alpha = load('alpha');
    const other = load('other');
    const claimer = load('claimer');
    await run(alpha, 'open', text('alpha'));
    await run(other, 'open', text('other'));
    const named = await find('alpha');
    const unnamed = await run(shop, 'share', named as Value);
    const kept = await find('other');
    assert.equal(typeof named, 'object');
    assert.equal(typeof unnamed, 'object');
    assert.equal(await charge(named), '2');
    assert.equal(await charge(unnamed), '2');
    alpha.stop('done');
    await settled();
    assert.equal(await find('alpha'), '"not exposed"');
    assert.equal(await charge(named), notExposed);
    assert.equal(await charge(unnamed), notExposed);
    assert.equal(await run(shop, 'note', named as Value), '"sent"');
    assert.equal(await run(shop, 'note', unnamed as Value), '"sent"');
    await settled();
    assert.deepEqual(said, []);
    assert.equal(await charge(kept), '2');

    // A Reload of the stopped Script makes no exposure without a new expose,
    // and another Script may claim the freed name, under a new Peer.
    alpha.reload(exposedSource('peer'), 'reset variables');
    await settled();
    assert.equal(await find('alpha'), '"not exposed"');
    assert.equal(await run(claimer, 'claim', text('alpha')), '"claimed"');
    const claimed = await find('alpha');
    assert.notEqual(claimed, named);
    assert.equal(await charge(claimed), '2');
    assert.equal(await charge(named), notExposed);

    // Explicit unexpose still needs the owner.
    assert.equal(await run(claimer, 'close', text('other')), '"closed"');
    assert.equal(await charge(kept), '2');
    assert.equal(await run(other, 'close', text('other')), '"closed"');
    assert.equal(await charge(kept), notExposed);
    assert.equal(await run(claimer, 'claim', text('other')), '"claimed"');

    // Disposing the owner Object stops its Script and withdraws.
    const owner = billingGroup.object(
      defineObjectKind({ name: 'exposure-owner', props: {} }),
      'owner',
      {},
    );
    const owned = load('owned', { owner });
    await run(owned, 'open', text('delta'));
    const delta = await find('delta');
    billingGroup.dispose(owner);
    await settled();
    assert.equal(await find('delta'), '"not exposed"');
    assert.equal(await charge(delta), notExposed);
    assert.equal(await run(claimer, 'claim', text('delta')), '"claimed"');

    // A successful Reload, a rejected one and an Extend keep the exposure;
    // a Host Stop whose reason reads "reload" is still a Stop.
    const kappa = load('kappa');
    await run(kappa, 'open', text('kappa'));
    const kappaPeer = await find('kappa');
    kappa.reload(exposedSource('peer'), 'reset variables');
    await settled();
    assert.equal(await charge(kappaPeer), '2');
    assert.throws(() => kappa.reload('on', 'reset variables'));
    kappa.extend('on extra\nend extra');
    await settled();
    assert.equal(await charge(kappaPeer), '2');
    kappa.stop('reload');
    await settled();
    assert.equal(await charge(kappaPeer), notExposed);
    assert.equal(await find('kappa'), '"not exposed"');

    // Revocation withdraws, without failing the Request already delivered;
    // the Reload and Stop that follow it find nothing left to drop.
    const rho = load('rho');
    await run(rho, 'open', text('rho'));
    const rhoPeer = await find('rho');
    assert.equal(await run(shop, 'hold', rhoPeer as Value), '2');
    await settled();
    assert.equal(await find('rho'), '"not exposed"');
    assert.equal(await charge(rhoPeer), notExposed);
    // The revoked Grant is gone, so the new code can't name it.
    rho.reload('on go\nend go', 'reset variables');
    rho.stop('done');
    await settled();
    assert.equal(await run(claimer, 'claim', text('rho')), '"claimed"');

    // Release matches the whole owner: the Group, the Script and the Grant's
    // name. Disabling withdraws; a repeated release is harmless.
    const sigma = load('sigma', { grant: 'net' });
    await run(sigma, 'open', text('sigma'));
    const sigmaPeer = await find('sigma');
    release('sigma', 'peer', 'disable');
    release('other', 'net', 'disable');
    billingRouter.impl.release!({
      binding: null,
      grantName: 'net',
      group: shopGroup,
      now: 0n,
      reason: 'disable',
      scriptName: 'sigma',
    });
    release('sigma', 'net', 'reload');
    assert.equal(await charge(sigmaPeer), '2');
    release('sigma', 'net', 'disable');
    release('sigma', 'net', 'disable');
    assert.equal(await charge(sigmaPeer), notExposed);
    assert.equal(await find('sigma'), '"not exposed"');
    assert.equal(await run(claimer, 'claim', text('sigma')), '"claimed"');
    // Another Script's later claim of the name survives the old owner's release.
    release('sigma', 'net', 'stop');
    assert.equal(await charge(await find('sigma')), '2');
  } finally {
    shopRouter.close();
    billingRouter.close();
    await Promise.all(drives.map(d => d.close()));
  }
};
