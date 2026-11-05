// Two peer routers over a MessageChannel (ADR 0165), shared by the Bun test
// and the CLI's Node runtime check so it runs under both.
import assert from 'node:assert/strict';
import { newDrivenGroup } from '../src/driver';
import { encodeValue, newGroup, peerCapability } from '../src/index';
import { messagePortLink, PeerRouter } from '../src/peer';

const costs = {
  expose: { fuel: 0 },
  unexpose: { fuel: 0 },
  reach: { fuel: 0 },
  post: { fuel: 0 },
  call: { fuel: 0 },
  caller: { fuel: 0 },
};

// The worker's side: it answers a charge by calling back the Peer it was
// handed, an unnamed exposure of the page's.
const workerSource = [
  'on go',
  '  ask peer to expose "billing" and wait',
  'end go',
  'on charge amount, back',
  '  send confirm with amount to back into confirmed and wait',
  '  ask peer to caller',
  '  return [confirmed, the via of it, the name of it]',
  'end charge',
  'on hang',
  '  wait 3600 s',
  'end hang',
  '',
].join('\n');

const pageSource = [
  'on go',
  '  ask peer to expose into back and wait',
  '  ask peer to reach "billing" into billing and wait',
  '  send charge with 12, back to billing into result and wait',
  '  return result',
  'end go',
  'on confirm amount',
  '  ask peer to caller',
  '  return [amount + 1, the via of it, the name of it]',
  'end confirm',
  'on stall',
  '  ask peer to reach "billing" into billing and wait',
  '  try',
  '    send hang to billing and wait',
  '  catch e',
  '    return the reason of e',
  '  end try',
  'end stall',
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

/**
 * A page and a worker, each its own Host with its own WebCrypto key, carry
 * Remote Sends over a MessageChannel: a `reach` by the port's name, a call
 * whose argument is a Peer for an unnamed exposure, a call back to it, and
 * the Caller Identity each end vouches for. Closing a port fails the call
 * waiting on it as `unreachable`, and nothing is sent after.
 */
export const verifyMessagePortLinks = async (): Promise<void> => {
  const page = await host('page', pageSource);
  const worker = await host('worker', workerSource);
  assert.notEqual(page.router.key, worker.router.key);
  const channel = new MessageChannel();
  const toWorker = messagePortLink(channel.port1, { name: 'billing' });
  const toPage = messagePortLink(channel.port2, { name: 'page' });
  page.router.connect(toWorker);
  worker.router.connect(toPage);
  try {
    await worker.script.request({ name: 'go', args: [] }).result;
    const result = await page.script.request({ name: 'go', args: [] }).result;
    assert.equal(encodeValue(result), '[[13,"port","billing"],"port","page"]');
    assert.equal(toWorker.key, worker.router.key);
    assert.equal(toPage.key, page.router.key);

    const stalled = page.script.request({ name: 'stall', args: [] });
    // Long enough for the reach and the call to cross.
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    toWorker.close();
    assert.equal((await stalled.result).asText(), 'unreachable');
    assert.equal(toWorker.closed, true);
    assert.equal(toWorker.send('{"post":"x"}'), false);
  } finally {
    page.router.close();
    worker.router.close();
    await Promise.all([page.drive.close(), worker.drive.close()]);
  }
};
