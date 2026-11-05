// The page's Host, linked to a real Worker: a reach, a call carrying a Peer
// the worker calls back, and a terminated worker failing a pending call.
import { newDrivenGroup } from '../../src/driver';
import { encodeValue, newGroup, peerCapability } from '../../src/index';
import { messagePortLink, PeerRouter } from '../../src/peer';

const free = { fuel: 0 };
// The test's outcome, or its error as text for the runner to show.
const run = async () => {
  try {
    return await test();
  } catch (error) {
    return { error: String(error) };
  }
};
const test = async () => {
  const { group } = newDrivenGroup({ newGroup }, { name: 'page' });
  const router = await PeerRouter.create(group);
  const script = group.load({
    name: 'shop',
    source: [
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
    ].join('\n'),
    grants: {
      peer: peerCapability(router.impl, {
        expose: free,
        unexpose: free,
        reach: free,
        post: free,
        call: free,
        caller: free,
      }).grant('all', null),
    },
  });
  const worker = new Worker('/worker.js', { type: 'module' });
  const link = messagePortLink(worker, { name: 'billing' });
  router.connect(link);
  const result = encodeValue(
    await script.request({ name: 'go', args: [] }).result,
  );
  const stalled = script.request({ name: 'stall', args: [] });
  await new Promise(resolve => setTimeout(resolve, 50));
  // A terminated worker sends no word: the page closes its link.
  worker.terminate();
  link.close();
  const stall = (await stalled.result).asText();
  return { result, stall };
};

(globalThis as { results?: Promise<unknown> }).results = run();
