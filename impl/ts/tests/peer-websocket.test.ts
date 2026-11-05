import { test } from 'bun:test';
import { verifyWebSocketLinks } from './peer-websocket-scenario';

test('a server and browser Hosts carry Remote Sends over WebSockets', async () => {
  await verifyWebSocketLinks();
});
