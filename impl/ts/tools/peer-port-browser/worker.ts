// The worker's Host: its own Group, key and router, linked to the page
// through `self`.
import { newDrivenGroup } from '../../src/driver';
import { newGroup, peerCapability } from '../../src/index';
import { messagePortLink, PeerRouter } from '../../src/peer';

// Made first: a worker drops messages that arrive before it listens, and
// the link holds what arrives until the router is ready.
const link = messagePortLink(self, { name: 'page' });
const free = { fuel: 0 };
const { group } = newDrivenGroup({ newGroup }, { name: 'worker' });
const router = await PeerRouter.create(group);
const script = group.load({
  name: 'billing',
  source: [
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
await script.request({ name: 'go', args: [] }).result;
router.connect(link);
