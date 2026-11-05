import { test } from 'bun:test';
import { verifyMessagePortLinks } from './peer-port-scenario';

test('a page and a worker Host carry Remote Sends over a MessageChannel', async () => {
  await verifyMessagePortLinks();
});
