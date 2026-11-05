import { test } from 'bun:test';
import { verifyPeerRouter } from './peer-router-scenario';

test('two peer routers carry Remote Sends over an in-memory pair of links', async () => {
  await verifyPeerRouter();
});
