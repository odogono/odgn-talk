import { expect, test } from 'bun:test';
import { newDrivenGroup } from '../src/driver';
import { createHttpHost } from '../src/http/index';
import { httpCapability } from '../src/http-capability';
import { newGroup } from '../src/index';

const costs = {
  serve: { fuel: 1 },
  unserve: { fuel: 1 },
  respond: { fuel: 1 },
};

// A Script whose Runs wait before answering, so exchanges stay open.
const slowSource = `on start
  ask http to serve "site", "/" and wait
  return the port of it
end start

on httpRequest {exchange: x}
  wait 5 s
  ask http to respond x, {body: "late"}
end httpRequest`;

const setUp = async (o: Parameters<typeof createHttpHost>[0] = {}) => {
  const host = createHttpHost(o);
  const driven = newDrivenGroup(
    { newGroup },
    { name: 'g', onPump: r => host.pumped(driven.group, r) },
  );
  const script = driven.group.load({
    name: 'main',
    source: slowSource,
    grants: { http: httpCapability(host.impl, costs).grant('all', undefined) },
  });
  const port = Number(
    (await script.request({ name: 'start' }).result).toString(),
  );
  return { host, port, ...driven };
};

const until = async (ok: () => boolean) => {
  while (!ok()) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test('detaching a Group answers its open exchanges 503 and closes its listener', async () => {
  const { host, port, group, drive } = await setUp();
  expect(host.registrations).toBe(1);
  const answer = fetch(`http://127.0.0.1:${port}/`);
  await until(() => host.openExchanges === 1);
  host.detach(group);
  expect((await answer).status).toBe(503);
  expect(host.registrations).toBe(0);
  expect(host.openExchanges).toBe(0);
  expect(host.addresses()).toEqual([]);
  await host.close();
  await drive.close();
});

test('drain answers what is still open 503 once its time is up, and stopAccepting turns new requests away', async () => {
  const { host, port, drive } = await setUp();
  const answer = fetch(`http://127.0.0.1:${port}/`);
  await until(() => host.openExchanges === 1);
  host.stopAccepting();
  await host.drain(50);
  expect((await answer).status).toBe(503);
  // A kept-alive connection is answered 503; a new one is refused.
  expect([503, 'refused']).toContain(
    await fetch(`http://127.0.0.1:${port}/`).then(
      r => r.status,
      () => 'refused',
    ),
  );
  await host.close();
  await drive.close();
});

test('a Grant the Host refuses an address fails serve with bad address', async () => {
  const host = createHttpHost({ allow: (_h, port) => port === 1 });
  const driven = newDrivenGroup(
    { newGroup },
    { name: 'g', onPump: r => host.pumped(driven.group, r) },
  );
  const script = driven.group.load({
    name: 'main',
    source: `on start
  try
    ask http to serve "site", "/" and wait
  catch {code: c}
    return c
  end try
end start`,
    grants: { http: httpCapability(host.impl, costs).grant('all', undefined) },
  });
  expect((await script.request({ name: 'start' }).result).toString()).toBe(
    '"bad address"',
  );
  await host.close();
  await driven.drive.close();
});
