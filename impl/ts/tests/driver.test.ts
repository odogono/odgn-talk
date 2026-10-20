import { describe, expect, test } from 'bun:test';
import {
  autoDrive,
  newDrivenGroup,
  type AutoDriveOptions,
} from '../src/driver';
import {
  defineCapability,
  formatInstant,
  HostError,
  newGroup,
  num,
  shape,
  type Call,
  type PumpResult,
} from '../src/index';

const driven = (
  source: string,
  options: AutoDriveOptions = {},
  grants = {},
) => {
  const lines: string[] = [];
  const { group, drive } = newDrivenGroup({
    ...options,
    name: 'g',
    trace: line => lines.push(line),
  });
  const script = group.load({ name: 's', source, grants });
  return { drive, group, lines, script };
};

describe('newDrivenGroup', () => {
  test('preserves Group options and starts idle', async () => {
    const lines: string[] = [];
    const { group, drive } = newDrivenGroup({
      name: 'seeded',
      seed: 42n,
      trace: line => lines.push(line),
      clock: () => 0n,
    });
    try {
      await drive.idle();
      expect(group.name).toBe('seeded');
      expect(lines).toEqual([]);
      const script = group.load({
        name: 's',
        source: 'on roll\n  return random(6)\nend roll',
      });
      expect(
        (await script.request({ name: 'roll', args: [] }).result).toString(),
      ).toBe('3');
      await drive.idle();
      expect(lines).toContain(`> pump clock=${formatInstant(0n)}`);
    } finally {
      drive.stop();
    }
  });

  test('forwards Pump errors and can drive again afterwards', async () => {
    let now = 0n;
    const errors: unknown[] = [];
    const { group, drive } = newDrivenGroup({
      name: 'errors',
      clock: () => now,
      onError: error => errors.push(error),
    });
    try {
      group.pump(1n);
      const script = group.load({ name: 's', source: 'on go\nend go' });
      const reply = script.request({ name: 'go', args: [] });
      await drive.idle();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(HostError);
      expect(errors[0]).toHaveProperty('code', 'clock backwards');
      now = 1n;
      drive.ready();
      await reply.result;
      await drive.idle();
      expect(errors).toHaveLength(1);
    } finally {
      drive.stop();
    }
  });

  test('pumps once per readiness, on a later macrotask', async () => {
    const pumps: PumpResult[] = [];
    const { drive, script } = driven('on go\n  return 1\nend go', {
      onPump: r => pumps.push(r),
    });
    const a = script.request({ name: 'go', args: [] });
    const b = script.request({ name: 'go', args: [] });
    expect(pumps).toHaveLength(0);
    expect((await a.result).toString()).toBe('1');
    expect((await b.result).toString()).toBe('1');
    await drive.idle();
    expect(pumps).toHaveLength(1);
  });

  test('a sliced Pump is followed by another', async () => {
    const states: string[] = [];
    const { drive, script } = driven(
      'on go\n  put 0 into n\n  repeat 200 times\n    add 1 to n\n  end repeat\n  return n\nend go',
      { pump: { fuelSlice: 200 }, onPump: r => states.push(r.state) },
    );
    expect(
      (await script.request({ name: 'go', args: [] }).result).toString(),
    ).toBe('200');
    await drive.idle();
    expect(states.length).toBeGreaterThan(2);
    expect(states.at(-1)).toBe('idle');
    expect(states.slice(0, -1).every(s => s === 'sliced')).toBe(true);
  });

  test('the default deadline timer pumps a wait on the wall clock', async () => {
    const { lines, script } = driven('on go\n  wait 30 ms\n  return 7\nend go');
    const start = Date.now();
    expect(
      (await script.request({ name: 'go', args: [] }).result).toString(),
    ).toBe('7');
    expect(Date.now() - start).toBeGreaterThanOrEqual(29);
    expect(lines.filter(l => l.startsWith('> pump'))).toHaveLength(2);
  });

  test('a supplied clock and deadline scheduler replace the defaults', async () => {
    let now = 1_000_000_000n;
    let fire: (() => void) | undefined;
    let at: bigint | undefined;
    const { drive, lines, script } = driven(
      'on go\n  wait 1 s\n  return 7\nend go',
      {
        clock: () => now,
        setDeadline: (when, f) => {
          at = when;
          fire = f;
          return () => (fire = undefined);
        },
      },
    );
    const result = script.request({ name: 'go', args: [] }).result;
    await drive.idle();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(at).toBe(now + 1_000_000n);
    now = at!;
    fire!();
    expect((await result).toString()).toBe('7');
    expect(lines).toContain(`> pump clock=${formatInstant(at!)}`);
  });

  test('readings never go backwards', async () => {
    let now = 2_000_000_000n;
    const errors: unknown[] = [];
    const { drive, lines, script } = driven('on go\nend go', {
      clock: () => now,
      onError: e => errors.push(e),
    });
    script.deliver({ name: 'go', args: [] });
    await drive.idle();
    now -= 1_000_000n;
    script.deliver({ name: 'go', args: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    await drive.idle();
    expect(errors).toEqual([]);
    const pumps = lines.filter(l => l.startsWith('> pump'));
    expect(pumps).toHaveLength(2);
    expect(pumps[0]).toBe(pumps[1]!);
  });

  test('an answer from a Promise resumes the Run', async () => {
    let started: Call<void> | undefined;
    const api = defineCapability('api', {
      fetch: {
        mode: 'suspending',
        result: shape.number,
        cost: { fuel: 0 },
        run: async call => {
          started = call;
          await new Promise(resolve => setTimeout(resolve, 5));
          return num(9);
        },
      },
    });
    const { script } = driven(
      'on go\n  ask api to fetch and wait\n  return it\nend go',
      {},
      { api: api.grant('all', undefined) },
    );
    expect(
      (await script.request({ name: 'go', args: [] }).result).toString(),
    ).toBe('9');
    expect(started?.signal.aborted).toBe(false);
  });

  test('stop cancels the scheduled Pump and later readiness', async () => {
    const pumps: PumpResult[] = [];
    const { drive, script } = driven('on go\nend go', {
      onPump: r => pumps.push(r),
    });
    script.deliver({ name: 'go', args: [] });
    drive.stop();
    await drive.idle();
    script.deliver({ name: 'go', args: [] });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(pumps).toHaveLength(0);
  });
});

test('autoDrive still drives a manually wired Group', async () => {
  const group = newGroup({ name: 'manual', onReady: () => drive.ready() });
  const drive = autoDrive(group);
  try {
    const script = group.load({
      name: 's',
      source: 'on go\n  return 3\nend go',
    });
    expect(
      (await script.request({ name: 'go', args: [] }).result).toString(),
    ).toBe('3');
    await drive.idle();
  } finally {
    drive.stop();
  }
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
};

describe('Drive.close', () => {
  test('stops every Script and queued Request before returning, releasing Grants once', async () => {
    const released: string[] = [];
    const api = defineCapability(
      'api',
      {
        touch: {
          mode: 'immediate',
          cost: { fuel: 0 },
          do: () => num(1),
        },
      },
      undefined,
      call => released.push(call.scriptName),
    );
    const lines: string[] = [];
    const { group, drive } = newDrivenGroup({
      name: 'g',
      trace: l => lines.push(l),
    });
    const replies = ['a', 'b'].map(
      name =>
        group
          .load({
            name,
            source: 'on go\n  ask api to touch\n  return it\nend go',
            grants: { api: api.grant('all', undefined) },
          })
          .request({ name: 'go', args: [] }).result,
    );
    const closing = drive.close('Application shutdown');
    expect(drive.close('Another reason')).toBe(closing);
    drive.stop(); // An active close owns the shutdown sequence.
    await closing;
    for (const reply of replies) {
      await expect(reply).rejects.toHaveProperty('code', 'send failed');
    }
    expect(released).toEqual(['a', 'b']);
    expect(lines.filter(l => l.startsWith('stopped '))).toHaveLength(2);
    expect(lines.some(l => l.includes('Another reason'))).toBe(false);
    expect(lines.some(l => l.includes('Application shutdown'))).toBe(true);
    const count = lines.length;
    drive.ready();
    await drive.idle();
    await drive.close();
    expect(lines).toHaveLength(count);
  });

  test('awaits asynchronous abort cleanup and drains its late failure', async () => {
    const cleanup = deferred<void>();
    const events: string[] = [];
    let signal: AbortSignal | undefined;
    const api = defineCapability('api', {
      fetch: {
        mode: 'suspending',
        cost: { fuel: 0 },
        run: async call => {
          signal = call.signal;
          await new Promise<void>(resolve =>
            call.signal.addEventListener(
              'abort',
              () => {
                events.push('abort');
                resolve();
              },
              { once: true },
            ),
          );
          await cleanup.promise;
          events.push('cleanup');
          throw new Error('Aborted');
        },
      },
    });
    const { drive, script, lines } = driven(
      'on go\n  ask api to fetch and wait\nend go',
      {},
      { api: api.grant('all', undefined) },
    );
    const reply = script.request({ name: 'go', args: [] }).result;
    await drive.idle();
    expect(signal?.aborted).toBe(false);
    let closed = false;
    const closing = drive.close().then(() => {
      closed = true;
      events.push('closed');
    });
    await drive.idle();
    expect(signal?.aborted).toBe(true);
    await expect(reply).rejects.toHaveProperty('code', 'send failed');
    expect(closed).toBe(false);
    cleanup.resolve();
    await closing;
    expect(events).toEqual(['abort', 'cleanup', 'closed']);
    expect(lines.some(l => l.includes('kind=late-answer'))).toBe(true);
  });

  test('awaits previously abandoned Host work but not another Group', async () => {
    const work = deferred<ReturnType<typeof num>>();
    const otherWork = deferred<ReturnType<typeof num>>();
    let signal: AbortSignal | undefined;
    const api = defineCapability('api', {
      fetch: {
        mode: 'suspending',
        cost: { fuel: 0 },
        run: call => {
          signal = call.signal;
          return work.promise;
        },
      },
    });
    const otherApi = defineCapability('other', {
      fetch: {
        mode: 'suspending',
        cost: { fuel: 0 },
        run: () => otherWork.promise,
      },
    });
    const a = driven(
      'on go\n  ask api to fetch and wait\nend go',
      {},
      { api: api.grant('all', undefined) },
    );
    const b = driven(
      'on go\n  ask api to fetch and wait\nend go',
      {},
      { api: otherApi.grant('all', undefined) },
    );
    try {
      const controller = new AbortController();
      const reply = a.script.request(
        { name: 'go', args: [] },
        { signal: controller.signal },
      ).result;
      b.script.request({ name: 'go', args: [] });
      await Promise.all([a.drive.idle(), b.drive.idle()]);
      controller.abort();
      await a.drive.idle();
      await expect(reply).rejects.toThrow();
      expect(signal?.aborted).toBe(true);
      let closed = false;
      const closing = a.drive.close().then(() => {
        closed = true;
      });
      await a.drive.idle();
      expect(closed).toBe(false);
      work.resolve(num(1));
      await closing;
      expect(closed).toBe(true);
    } finally {
      work.resolve(num(1));
      otherWork.resolve(num(1));
      await Promise.all([a.drive.close(), b.drive.close()]);
    }
  });

  test('aborts callback-style calls without waiting for an unavailable completion Promise', async () => {
    let call: Call<void> | undefined;
    const api = defineCapability('api', {
      fetch: {
        mode: 'suspending',
        cost: { fuel: 0 },
        start: c => {
          call = c;
        },
      },
    });
    const { drive, script, lines } = driven(
      'on go\n  ask api to fetch and wait\nend go',
      {},
      { api: api.grant('all', undefined) },
    );
    const reply = script.request({ name: 'go', args: [] }).result;
    await drive.idle();
    await drive.close();
    expect(call?.signal.aborted).toBe(true);
    await expect(reply).rejects.toThrow();
    const pumps = lines.filter(l => l.startsWith('> pump')).length;
    call!.answer(num(2));
    await drive.idle();
    expect(lines.filter(l => l.startsWith('> pump'))).toHaveLength(pumps);
  });

  test('closes a stopped driver and cancels a pending deadline', async () => {
    let fire: (() => void) | undefined;
    const { drive, script } = driven('on go\n  wait 1 s\nend go', {
      clock: () => 0n,
      setDeadline: (_at, callback) => {
        fire = callback;
        return () => {
          fire = undefined;
        };
      },
    });
    const reply = script.request({ name: 'go', args: [] }).result;
    await drive.idle();
    expect(fire).toBeDefined();
    drive.stop();
    await drive.close();
    expect(fire).toBeUndefined();
    await expect(reply).rejects.toThrow();
  });

  test('can close from onPump without resolving idle inside that callback', async () => {
    let closing: Promise<void> | undefined;
    const { group, drive } = newDrivenGroup({
      name: 'g',
      onPump: () => {
        closing ??= drive.close();
      },
    });
    group
      .load({ name: 's', source: 'on go\nend go' })
      .deliver({ name: 'go', args: [] });
    await drive.idle();
    await closing;
    expect(group.pump(BigInt(Date.now()) * 1000n).state).toBe('stopped');
  });

  test('async disposal stops Scripts even when the scope throws', async () => {
    const { group, drive } = newDrivenGroup({ name: 'g' });
    const script = group.load({ name: 's', source: 'on go\nend go' });
    const failure = new Error('Scope failed');
    await expect(
      (async () => {
        await using resource = drive;
        expect(resource).toBe(drive);
        throw failure;
      })(),
    ).rejects.toBe(failure);
    expect(group.pump(BigInt(Date.now()) * 1000n).state).toBe('stopped');
    await drive[Symbol.asyncDispose]();
    const reply = script.request({ name: 'go', args: [] });
    group.pump(BigInt(Date.now()) * 1000n);
    await expect(reply.result).rejects.toThrow();
  });

  test.each(['clock', 'pump', 'onPump', 'onError'] as const)(
    'rejects and stops scheduling after a %s failure',
    async failureAt => {
      const failure = new Error(failureAt);
      const errors: unknown[] = [];
      const { group, drive } = newDrivenGroup({
        name: 'g',
        clock: () => {
          if (failureAt === 'clock') {
            throw failure;
          }
          return 0n;
        },
        onPump: () => {
          if (failureAt === 'onPump') {
            throw failure;
          }
        },
        onError: error => {
          errors.push(error);
          if (failureAt === 'onError') {
            throw failure;
          }
        },
      });
      if (failureAt === 'pump' || failureAt === 'onError') {
        group.pump(1n);
      }
      await expect(drive.close()).rejects.toThrow();
      expect(errors).toHaveLength(1);
      const count = errors.length;
      drive.ready();
      await drive.idle();
      expect(errors).toHaveLength(count);
    },
  );
});
