import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  defineCapability,
  defineObjectKind,
  newGroup,
  num,
  shape,
  type Call,
} from '../src/index';
import { runTraceCase } from '../tools/trace-case';

for (const name of [
  'ask-wait-retention',
  'foreign-call-retention',
  'event-capture-wait-retention',
  'event-capture-block-retention',
  'event-object-wait-retention',
  'event-object-block-retention',
  'join-pending-retention',
  'join-early-answer-retention',
]) {
  test(`${name} agrees with its Trace in ordinary and save/restore execution`, () => {
    const dir = resolve(import.meta.dir, '../../../corpus/limits', name);
    const setup = Bun.TOML.parse(
      readFileSync(resolve(dir, 'case.toml'), 'utf8'),
    );
    expect(runTraceCase(dir, setup as never).divergence).toBeUndefined();
  });
}

for (const filter of ['capture', 'object', 'both'] as const) {
  const captures = filter !== 'object';
  const objects = filter !== 'capture';
  const retained = 192 + (captures ? 24 + 32 : 0) + (objects ? 32 : 0);
  for (const limit of [retained - 1, retained]) {
    test(`two event branches each retain ${filter} at ${limit} bytes`, () => {
      const g = newGroup({ name: 'g' });
      const door = g.object(
        defineObjectKind({ name: 'door', props: {} }),
        'd',
        undefined,
      );
      const pattern = `${captures ? ' ^n' : ''}${objects ? ' from (door)' : ''}`;
      const s = g.load({
        name: 's',
        source: `on go\n${captures ? ' put 7 into n\n' : ''} wait for\n when ping${pattern} then return\n when pong${pattern} then return\n end wait\nend go`,
        objects: { door },
        limits: { persistentState: limit },
      });
      s.deliver({ name: 'go' });
      const reports = g.pump(0n).reports;
      expect(
        reports.some(r => r.kind === 'run end' && r.outcome === 'limit fault'),
      ).toBe(limit < retained);
      expect(s.counters().persistentState).toBe(
        limit < retained ? 0 : retained,
      );
    });
  }
}

for (const limit of [223, 224]) {
  test(`ask retains its 48-byte pending call at ${limit} bytes`, () => {
    const lines: string[] = [];
    const calls: Call<void>[] = [];
    const api = defineCapability('api', {
      fetch: {
        mode: 'suspending',
        args: [shape.number],
        result: shape.number,
        cost: { fuel: 0 },
        start: call => calls.push(call),
      },
    });
    const g = newGroup({ name: 'g', trace: line => lines.push(line) });
    const s = g.load({
      name: 's',
      source: 'on go\n ask api to fetch 7 and wait\n return it\nend go',
      grants: { api: api.grant('all', undefined) },
      limits: { persistentState: limit },
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    expect(calls).toHaveLength(1);
    if (limit === 223) {
      expect(
        lines.some(line => line.startsWith('fault s/r1 limit=persistent')),
      ).toBe(true);
      expect(calls[0]!.signal.aborted).toBe(true);
      expect(lines.indexOf('abandon s/r1.c1')).toBeGreaterThan(
        lines.findIndex(line => line.startsWith('fault s/r1 ')),
      );
    } else {
      expect(s.counters().persistentState).toBe(224);
      expect(calls[0]!.signal.aborted).toBe(false);
    }
    calls[0]!.answer(num(7));
    g.pump(0n);
    expect(
      lines.some(line => line.startsWith('run s/r1 outcome=completed')),
    ).toBe(limit === 224);
  });
}

for (const limit of [263, 264]) {
  test(`a foreign Function Value retains its pending call at ${limit} bytes`, () => {
    const lines: string[] = [];
    const g = newGroup({ name: 'g', trace: line => lines.push(line) });
    const home = g.load({
      name: 'home',
      source: 'on export\n return f\nend export\nfunction f\n return 7\nend f',
    });
    home.deliver({ name: 'export' });
    const report = g.pump(0n).reports.find(r => r.kind === 'run end');
    if (report?.kind !== 'run end' || !report.result) {
      throw new Error('no exported Function Value');
    }
    const s = g.load({
      name: 's',
      source: 'on go f\n f() and wait\n return it\nend go',
      limits: { persistentState: limit },
    });
    s.deliver({ name: 'go', args: [report.result] });
    g.pump(0n);
    expect(
      lines.some(line => line.startsWith('fault s/r1 limit=persistent')),
    ).toBe(limit === 263);
    expect(lines.includes('abandon s/r1.c1')).toBe(limit === 263);
    expect(
      lines.some(line => line.startsWith('run home/r2 outcome=completed')),
    ).toBe(true);
    expect(
      lines.some(line => line.startsWith('run s/r1 outcome=completed')),
    ).toBe(limit === 264);
  });
}

for (const block of [false, true]) {
  for (const filter of ['capture', 'object', 'Script'] as const) {
    // A captured number counts again in the pending branch; an evaluated
    // object costs 16 bytes, while a named Script is not a Value.
    const retained =
      176 +
      (block ? 16 : 0) +
      (filter === 'capture' ? 40 : filter === 'object' ? 16 : 0);
    for (const limit of [retained - 1, retained]) {
      test(`${block ? 'block' : 'one-line'} wait for retains ${filter} at ${limit} bytes`, () => {
        const lines: string[] = [];
        const g = newGroup({ name: 'g', trace: line => lines.push(line) });
        const door = g.object(
          defineObjectKind({ name: 'door', props: {} }),
          'd',
          undefined,
        );
        g.load({ name: 'other', source: '' });
        const branch = `ping${filter === 'capture' ? ' ^n' : filter === 'object' ? ' from door' : ' from other'}`;
        const s = g.load({
          name: 's',
          source: `on go\n${filter === 'capture' ? ' put 7 into n\n' : ''}${block ? ` wait for\n when ${branch} then return\n end wait` : ` wait for ${branch}`}\nend go`,
          objects: { door },
          limits: { persistentState: limit },
        });
        s.deliver({ name: 'go' });
        g.pump(0n);
        expect(
          lines.some(line => line.startsWith('fault s/r1 limit=persistent')),
        ).toBe(limit < retained);
        expect(s.counters().persistentState).toBe(
          limit < retained ? 0 : retained,
        );
      });
    }
  }
}
