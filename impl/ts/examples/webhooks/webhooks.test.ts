import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { startServer } from './main';
import { caseFiles, runScenario } from './scenario';

describe('the recorded scenario', () => {
  // Rerecord with `bun impl/ts/examples/webhooks/main.ts record` after
  // changing the Host or its Script, then bless the case.
  test('matches the committed Trace Case', async () => {
    const files = await caseFiles();
    for (const [file, content] of Object.entries(files)) {
      const committed = readFileSync(
        new URL(
          `../../../../corpus/examples/webhooks/${file}`,
          import.meta.url,
        ),
        'utf8',
      );
      expect(content).toBe(committed);
    }
  });

  test('aborts the fetches of abandoned calls and replies to every Request', async () => {
    const { aborted, events, results, vars } = await runScenario();
    expect(aborted).toEqual([
      'http://accounts.test/hooks',
      'http://fulfilment.test/hooks',
    ]);
    expect(results).toEqual([
      '{status: "ignored"}',
      '{status: 202, attempts: 1}',
      '{status: "rejected", attempts: 1}',
      '{status: 200, attempts: 2}',
      '{status: "timeout", attempts: 1}',
      'rejected: send failed',
    ]);
    expect(events.map(e => `${e.type} ${e.outcome}`)).toEqual([
      'user.signup ignored',
      'order.created 202',
      'invoice.paid rejected',
      'order.created 200',
      'invoice.paid timeout',
    ]);
    expect(vars.map(([k, v]) => `${k}=${v}`)).toEqual([
      'delivered=2',
      'failed=["invoice.paid", "invoice.paid"]',
    ]);
  });
});

describe('the server', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  test('answers webhooks over HTTP on the real Clock', async () => {
    const server = startServer({ port: 0 });
    stop = server.stop;
    const post = (body: unknown, signal?: AbortSignal) =>
      fetch(`${server.base}/hooks`, {
        body: JSON.stringify(body),
        method: 'POST',
        signal,
      });
    const ok = await post({ type: 'order.created', data: { id: 1 } });
    expect(await ok.json()).toEqual({ status: 202, attempts: 1 });
    const ignored = await post({ type: 'user.signup', data: {} });
    expect(await ignored.json()).toEqual({ status: 'ignored' });
    const rejected = await post({ type: 'invoice.paid', data: { fail: true } });
    expect(await rejected.json()).toEqual({ status: 'rejected', attempts: 1 });
    // `slow` outlasts post's 2 s maxPending, so the call times out.
    const slow = await post({ type: 'invoice.paid', data: { slow: true } });
    expect(await slow.json()).toEqual({ status: 'timeout', attempts: 1 });
    // A client that hangs up cancels its Run before it records anything.
    const client = new AbortController();
    const hungUp = post(
      { type: 'order.created', data: { slow: true } },
      client.signal,
    );
    await Bun.sleep(100);
    client.abort();
    await expect(hungUp).rejects.toThrow();
    await Bun.sleep(100);
    const events = (await (await fetch(`${server.base}/events`)).json()) as {
      outcome: string;
    }[];
    expect(events.map(e => e.outcome)).toEqual([
      '202',
      'ignored',
      'rejected',
      'timeout',
    ]);
    expect(server.host.script.counters().runs).toBe(5);
  }, 10_000);
});
