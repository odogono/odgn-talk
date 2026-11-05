// Peer routers over WebSockets (ADR 0165), shared by the Bun test and the
// CLI's Node runtime check so it runs under both. The sockets here are an
// in-memory pair with a WHATWG `WebSocket`'s surface; the CLI's tests run
// the link over a real one, against `--listen ws://`.
import assert from 'node:assert/strict';
import { toBase64 } from '../src/base64';
import { newDrivenGroup } from '../src/driver';
import { encodeValue, newGroup, peerCapability } from '../src/index';
import {
  acceptWebSocket,
  newHostKey,
  PeerRouter,
  webSocketLink,
  type WebSocketEndpoint,
} from '../src/peer';

const costs = {
  expose: { fuel: 0 },
  unexpose: { fuel: 0 },
  reach: { fuel: 0 },
  post: { fuel: 0 },
  call: { fuel: 0 },
  caller: { fuel: 0 },
};

/** One end of an in-memory WebSocket: what it sends arrives at the other. */
class FakeSocket extends EventTarget implements WebSocketEndpoint {
  readyState = 1;
  other: FakeSocket | undefined;
  readonly sent: string[] = [];
  closedWith: number | undefined;

  constructor(readonly url?: string) {
    super();
  }

  send(data: string) {
    this.sent.push(data);
    const other = this.other!;
    setTimeout(() => {
      if (other.readyState === 1) {
        other.dispatchEvent(new MessageEvent('message', { data }));
      }
    }, 0);
  }

  close(code?: number) {
    if (this.readyState >= 2) {
      return;
    }
    this.closedWith = code;
    for (const end of [this, this.other!]) {
      end.readyState = 3;
      setTimeout(() => end.dispatchEvent(new Event('close')), 0);
    }
  }
}

const pair = (url: string): [FakeSocket, FakeSocket] => {
  const browser = new FakeSocket(url);
  const server = new FakeSocket();
  browser.other = server;
  server.other = browser;
  return [browser, server];
};

const settle = async () => {
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
};

// The server's chat: it records who joined, as its `authenticate` vouched,
// and greets each by calling back the Peer the browser handed it.
const serverSource = [
  'script variable inboxes = []',
  'on go',
  '  ask peer to expose "chat" and wait',
  'end go',
  'on join inbox',
  '  ask peer to caller',
  '  put it into who',
  '  put inbox after inboxes',
  '  send said with "welcome " & the principal of who to inbox into heard and wait',
  '  return [the via of who, the principal of who, heard]',
  'end join',
  'on first',
  '  return item 1 of inboxes',
  'end first',
  '',
].join('\n');

const browserSource = [
  'on go',
  '  ask peer to expose into inbox and wait',
  '  ask peer to reach "chat" into server and wait',
  '  send join with inbox to server into joined and wait',
  '  return joined',
  'end go',
  'on said line',
  '  ask peer to caller',
  '  return [line, the via of it, the origin of it]',
  'end said',
  // Bob is handed Alice's inbox: the server doesn't forward.
  'on steal',
  '  ask peer to reach "chat" into server and wait',
  '  send first to server into theirs and wait',
  '  try',
  '    send said with "hello" to theirs and wait',
  '  catch e',
  '    return the reason of e',
  '  end try',
  'end steal',
  'on knock',
  '  try',
  '    ask peer to reach "chat" and wait',
  '  catch e',
  '    return the code of e',
  '  end try',
  'end knock',
  '',
].join('\n');

const host = async (name: string, source: string) => {
  const { group, drive } = newDrivenGroup({ newGroup }, { name });
  const router = await PeerRouter.create(group);
  const script = group.load({
    name,
    source,
    grants: { peer: peerCapability(router.impl, costs).grant('all', null) },
  });
  return { drive, router, script };
};

const tokens: Record<string, string> = { a: 'alice', b: 'bob' };

/**
 * A server and two browsers carry Remote Sends over WebSockets: each end
 * proves its key, the server's `authenticate` adds a principal to the
 * Caller Identity, and the browser's has the server's origin. A Peer of
 * Alice's that the server hands to Bob fails `unreachable`. A refused token,
 * a wrong pin, a key that isn't the fingerprint's and a bad proof each close
 * the socket.
 */
export const verifyWebSocketLinks = async (): Promise<void> => {
  const server = await host('server', serverSource);
  const alice = await host('alice', browserSource);
  const bob = await host('bob', browserSource);
  const all = [server, alice, bob];
  const accept = (socket: FakeSocket) => {
    const link = acceptWebSocket(socket, {
      authenticate: token =>
        token && tokens[token] ? { principal: tokens[token] } : undefined,
    });
    server.router.connect(link);
    return link;
  };
  const browse = (
    who: typeof alice,
    token: string,
    options: { pin?: string; url?: string } = {},
  ) => {
    const [mine, theirs] = pair(options.url ?? 'wss://chat.example/peer');
    const link = webSocketLink(mine, { name: 'chat', token, pin: options.pin });
    who.router.connect(link);
    return { link, accepted: accept(theirs), socket: mine };
  };
  try {
    await server.script.request({ name: 'go', args: [] }).result;
    const a = browse(alice, 'a', {
      url: `wss://chat.example/peer#${server.router.key}`,
    });
    const joined = await alice.script.request({ name: 'go', args: [] }).result;
    assert.equal(
      encodeValue(joined),
      '["ws","alice",["welcome alice","ws","wss://chat.example"]]',
    );
    assert.equal(a.link.key, server.router.key);
    assert.equal(a.accepted.key, alice.router.key);

    const b = browse(bob, 'b');
    await bob.script.request({ name: 'go', args: [] }).result;
    const stolen = await bob.script.request({ name: 'steal', args: [] }).result;
    assert.equal(stolen.asText(), 'unreachable');
    assert.equal(b.link.closed, false);

    // A token `authenticate` refuses closes the socket before any Remote Send.
    const carol = await host('carol', browserSource);
    all.push(carol);
    const c = browse(carol, 'nobody');
    const knocked = await carol.script.request({ name: 'knock', args: [] })
      .result;
    assert.equal(knocked.asText(), 'bad address');
    assert.equal(c.accepted.closed, true);
    assert.equal(c.link.closed, true);

    // A pin the server's key doesn't match closes it at the browser.
    const dave = await host('dave', browserSource);
    all.push(dave);
    const d = browse(dave, 'a', { pin: '0'.repeat(64) });
    await settle();
    assert.equal(d.link.closed, true);
    assert.equal(d.accepted.closed, true);

    // A key that isn't the fingerprint's, and a proof that doesn't verify.
    const one = await newHostKey();
    const other = await newHostKey();
    const forge = async (key: Uint8Array, proof: string | undefined) => {
      const [mine, theirs] = pair('wss://chat.example/peer');
      const link = accept(theirs);
      mine.send(
        JSON.stringify({
          hello: one.fingerprint,
          key: toBase64(key),
          nonce: 'ab'.repeat(16),
          token: 'a',
        }),
      );
      if (proof !== undefined) {
        mine.send(JSON.stringify({ proof }));
      }
      await settle();
      return link;
    };
    assert.equal((await forge(other.signer.spki, undefined)).closed, true);
    const badProof = toBase64(await one.signer.sign(new Uint8Array(8)));
    const forged = await forge(one.signer.spki, badProof);
    assert.equal(forged.closed, true);
    assert.equal(forged.key, '');
  } finally {
    for (const h of all) {
      h.router.close();
    }
    await Promise.all(all.map(h => h.drive.close()));
  }
};
