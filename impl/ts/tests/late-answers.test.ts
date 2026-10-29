import { expect, test } from 'bun:test';
import {
  defineCapability,
  newGroup,
  ScriptError,
  shape,
  text,
  type Call,
} from '../src/index';

for (const ended of ['answer', 'fail', 'timeout', 'stop', 'reload'] as const) {
  test(`late answers and failures after ${ended} are queued and ignored`, () => {
    const lines: string[] = [];
    let call: Call<void> | undefined;
    const capability = defineCapability('remote', {
      read: {
        mode: 'suspending',
        cost: { fuel: 0 },
        result: shape.text,
        maxPendingMs: 1,
        start: c => {
          call = c;
        },
      },
    });
    const source = 'on go\n ask api to read and wait\nend go';
    const grants = { api: capability.grant('all', undefined) };
    const group = newGroup({ name: 'g', trace: line => lines.push(line) });
    const script = group.load({ name: 's', source, grants });
    script.deliver({ name: 'go' });
    group.pump(0n);
    expect(call).toBeDefined();
    if (ended === 'answer') {
      call!.answer(text('first'));
    } else if (ended === 'fail') {
      call!.fail(new ScriptError('failed', 'first'));
    } else if (ended === 'stop') {
      script.stop('finished');
    } else if (ended === 'reload') {
      script.reload(source, 'reset variables');
    }
    const now = ended === 'timeout' ? 1000n : 0n;
    group.pump(now);
    expect(group.inspect().scripts[0]!.runs).toEqual([]);

    const before = lines.length;
    call!.answer(text('late'), { fuel: 100 });
    call!.fail(new ScriptError('failed', 'late'));
    // Admission queues both inputs; only Pump records and processes them.
    expect(lines).toHaveLength(before);
    const result = group.pump(now);
    expect(result.fuelUsed).toBe(0);
    expect(result.reports).toEqual([]);
    expect(group.inspect().scripts[0]!.runs).toEqual([]);
    expect(
      lines.slice(before).filter(line => line.includes('late-answer')),
    ).toEqual([
      `note ${call!.id} kind=late-answer`,
      `note ${call!.id} kind=late-answer`,
    ]);
    expect(lines.slice(before).some(line => line.startsWith('refused'))).toBe(
      false,
    );
  });
}
