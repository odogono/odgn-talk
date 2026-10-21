// The checks every consumer of the packed package runs: Node, Bun and a
// browser import this file unchanged, so it is plain JavaScript.
import * as talk from '@northtalk/ts';
import * as session from '@northtalk/ts/session';
import * as driver from '@northtalk/ts/driver';
import * as notify from '@northtalk/ts/notify';
import * as setup from '@northtalk/ts/setup';
import * as store from '@northtalk/ts/store';
import * as debug from '@northtalk/ts/debug';
import * as wasm from '@northtalk/ts/wasm';
import * as messageLayer from '@northtalk/ts/message-layer';

const expect = (ok, message) => {
  if (!ok) {
    throw new Error(message);
  }
};

/** Runs a Script through `.` and `./session`; returns what passed. */
export const smoke = async () => {
  for (const [name, module] of Object.entries({
    driver,
    notify,
    setup,
    store,
    debug,
    wasm,
    messageLayer,
  })) {
    expect(Object.keys(module).length > 0, `${name} exports nothing`);
  }
  const clock = talk.parseInstant('2026-10-17T09:00:00Z');
  const group = talk.newGroup({ name: 'smoke' });
  const script = group.load({
    name: 'main',
    source: 'on total a, b\n  return a + b\nend total',
  });
  const reply = script.request({
    name: 'total',
    args: [talk.num(2), talk.num(3)],
  });
  group.pump(clock);
  expect((await reply.result).toString() === '5', 'Group request');
  const combined = script.requestPump(
    { name: 'total', args: [talk.num(20), talk.num(22)] },
    clock,
  );
  expect(combined.admitted && combined.pump.ok, 'Combined Request/Pump');
  expect(
    (await combined.requested.result).toString() === '42',
    'Combined result',
  );
  const driven = driver.newDrivenGroup(talk.createCore(), {
    name: 'driven',
    clock: () => clock,
  });
  let cleaned = false;
  const cleanup = talk.defineCapability('cleanup', {
    fetch: {
      mode: 'suspending',
      cost: { fuel: 0 },
      run: async call => {
        await new Promise(resolve =>
          call.signal.addEventListener('abort', resolve, { once: true }),
        );
        await new Promise(resolve => setTimeout(resolve, 0));
        cleaned = true;
        return talk.nothing;
      },
    },
  });
  try {
    const drivenScript = driven.group.load({
      name: 'main',
      source: 'on go\n  return 7\nend go',
    });
    expect(
      (
        await drivenScript.request({ name: 'go', args: [] }).result
      ).toString() === '7',
      'Driven Group request',
    );
    await driven.drive.idle();
    const waiting = driven.group
      .load({
        name: 'waiting',
        source: 'on go\n  ask cleanup to fetch and wait\nend go',
        grants: { cleanup: cleanup.grant('all', undefined) },
      })
      .request({ name: 'go', args: [] });
    await driven.drive.idle();
    await driven.drive.close();
    expect(
      cleaned,
      'Close awaits Host Promise cleanup across package subpaths',
    );
    await waiting.result.then(
      () => {
        throw new Error('Close did not stop the Request');
      },
      error => expect(error.code === 'send failed', 'Close settles Requests'),
    );
  } finally {
    await driven.drive.close();
  }
  const buffer = messageLayer.encodeBinaryValue(talk.dec('0.00'));
  expect(
    messageLayer.decodeBinaryValue(buffer).toString() === '0.00',
    'Binary codec',
  );
  const host = new session.SessionHost({ now: () => clock });
  host.input('put 2 + 3 into x');
  expect(host.input('x * 2')[0] === '10', 'Session Entry');
  return `language ${talk.coreVersions.language}: Group and Session ran`;
};
