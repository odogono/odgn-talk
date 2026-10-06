import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  codeIdentity,
  decodeValue,
  defineObjectKind,
  encodeValue,
  HostError,
  LoadError,
  MailboxFull,
  newGroup,
  parseInstant,
  restore,
  ScriptError,
  text,
  type Value,
} from '../src/index';
import { num } from '../src/values';

const clock = parseInstant('2026-09-30T09:00:00Z');
const later = (seconds: number) => clock + BigInt(seconds) * 1_000_000_000n;
const group = () => {
  const lines: string[] = [];
  return {
    g: newGroup({ name: 'test', trace: line => lines.push(line) }),
    lines,
  };
};
const withoutIdentity = (lines: string[]) =>
  lines.map(line => line.replace(/ identity=[\da-f]{64}$/, ''));

describe('loading', () => {
  test('a Script loads with its code identity in the Trace', () => {
    const { g, lines } = group();
    const source = 'on go\nend go';
    g.load({ name: 'a', source });
    const identity = createHash('sha256')
      .update(
        `odgn-talk code identity 1\n1.0-rc.2\n0\nscript\na\nsource\n${source}`,
      )
      .digest('hex');
    expect(codeIdentity('script', 'a', source)).toBe(identity);
    expect(lines).toEqual([`> load a identity=${identity}`]);
  });

  test('a rejected Script writes its diagnostics and is never added', () => {
    const { g, lines } = group();
    expect(() =>
      g.load({ name: 'bad', source: 'on go\n  return absent\nend go' }),
    ).toThrow(LoadError);
    expect(withoutIdentity(lines)).toEqual([
      '> load bad',
      'diag bad code="unknown name" pos=2:10',
    ]);
    expect(g.script('bad')).toBeUndefined();
  });

  test('a failing initialiser is the diagnostic `initialiser failed` at the raising instruction', () => {
    const { g, lines } = group();
    let error: unknown;
    try {
      g.load({ name: 'bad', source: 'constant x = 1 / 0\non go\nend go' });
    } catch (error_) {
      error = error_;
    }
    expect(error).toBeInstanceOf(LoadError);
    expect(
      (error as LoadError).diagnostics.map(d => [
        d.code,
        d.unit,
        d.line,
        d.col,
      ]),
    ).toEqual([['initialiser failed', 'bad', 1, 16]]);
    expect(withoutIdentity(lines)).toEqual([
      '> load bad',
      'diag bad code="initialiser failed" pos=1:16',
    ]);
    expect(g.script('bad')).toBeUndefined();
  });
});

describe('Deliveries and Pumps', () => {
  test('ordinary Decision dispatch must pay the complete first instruction', () => {
    for (const budget of [4, 5]) {
      const { g } = group();
      const s = g.load({ name: 's', source: 'on go\n return 1 / 0\nend go\n' });
      s.decide({ name: 'go', limits: { fuelPerRun: budget } });
      const result = g.pump(clock);
      expect(result.reports).toMatchObject(
        budget === 4
          ? [{ outcome: 'limit fault', fuel: 0 }, { verdict: 'undecided' }]
          : [{ verdict: 'allowed' }, { outcome: 'limit fault', fuel: 5 }],
      );
    }
  });

  test('replacement waits for the combined dispatch charge', () => {
    for (const budget of [4, 5]) {
      const { g, lines } = group();
      const s = g.load({
        name: 's',
        source: 'on work, replacing\n wait 1 s\nend work\n',
      });
      s.deliver({ name: 'work' });
      g.pump(clock);
      s.deliver({ name: 'work', limits: { fuelPerRun: budget } });
      const result = g.pump(clock);
      expect(result.reports).toMatchObject([
        { run: 's/r2', outcome: 'limit fault', fuel: budget === 4 ? 0 : 5 },
        ...(budget === 5 ? [{ run: 's/r1', outcome: 'cancelled' }] : []),
      ]);
      g.pump(later(1));
      expect(lines).toContain(
        budget === 4
          ? 'run s/r1 outcome=completed delivery=d1 handler=work fuel=18 alloc=0'
          : 'run s/r1 outcome=cancelled delivery=d1 handler=work fuel=15 alloc=0',
      );
    }
  });

  test("a Delivery runs in the Pump that drains it, written as chapter 11's records", () => {
    const { g, lines } = group();
    const a = g.load({
      name: 'a',
      source:
        'script variable n = 0\non bump by\n  add by to n\n  return n\nend bump',
    });
    expect(a.deliver({ name: 'bump', args: [num(2)] })).toBe('d1');
    const result = g.pump(clock);
    g.inspect();
    expect(withoutIdentity(lines)).toEqual([
      '> load a',
      '> deliver d1 to=a message=bump args=[2]',
      '> pump clock=2026-09-30T09:00:00Z',
      'seg a/r1 start delivery=d1 handler=bump clause=1 fuel=17 alloc=16 state=16 end=return',
      'run a/r1 outcome=completed delivery=d1 handler=bump value=2 fuel=17 alloc=16',
      'pumped state=idle fuel=17',
      '> vars',
      'vars a n=2',
    ]);
    expect(result.state).toBe('idle');
    expect(result.reports).toMatchObject([
      { kind: 'run end', run: 'a/r1', outcome: 'completed', fuel: 17 },
    ]);
  });

  test('a Request settles with the result, or rejects with `send failed`', async () => {
    const { g } = group();
    const a = g.load({
      name: 'a',
      source: 'on ok\n  return "fine"\nend ok\non bad\n  throw "nope"\nend bad',
    });
    const ok = a.request({ name: 'ok' });
    const bad = a.request({ name: 'bad' });
    g.pump(clock);
    expect((await ok.result).toString()).toBe('"fine"');
    expect(bad.result).rejects.toBeInstanceOf(ScriptError);
  });

  test('an error map is written without the message a Core-raised one has', () => {
    const { g, lines } = group();
    g.load({ name: 'a', source: 'on go\n  return "x" + 1\nend go' }).deliver({
      name: 'go',
    });
    g.pump(clock);
    expect(lines.find(line => line.startsWith('run '))).toBe(
      'run a/r1 outcome=errored delivery=d1 handler=go error={code: "wrong kind", expected: "number", got: "text", value: "x", at: {unit: "a", handler: "go", line: 2, column: 14}} fuel=13 alloc=0',
    );
    expect(lines).toContain('raise a/r1 code="wrong kind" at=a:4 pos=2:14');
  });

  test('a message with no clause is unhandled', () => {
    const { g, lines } = group();
    g.load({ name: 'a', source: 'on go x\nend go' }).deliver({ name: 'go' });
    g.pump(clock);
    expect(lines.slice(-4)).toEqual([
      'seg a/r1 start delivery=d1 handler=go fuel=0 alloc=0 state=0 end=unhandled',
      'run a/r1 outcome=unhandled delivery=d1 handler=go fuel=0 alloc=0',
      'unhandled d1 message=go',
      'pumped state=idle fuel=0',
    ]);
  });

  test("a Guard's error is a guard-skip, and its non-boolean a skip with the value", () => {
    const { g, lines } = group();
    const a = g.load({
      name: 'a',
      source:
        'on pick n where n > 1\nend pick\non pick n where n\nend pick\non pick n\nend pick',
    });
    a.deliver({ name: 'pick', args: [text('x')] });
    g.pump(clock);
    expect(lines.filter(line => line.startsWith('guard-skip'))).toEqual([
      'guard-skip a/r1 at=a:4 pos=1:19 code="can\'t compare"',
      'guard-skip a/r1 at=a:10 pos=3:17 value="x"',
    ]);
    expect(lines).toContainEqual(expect.stringContaining('clause=3'));
  });

  test('a Limit Fault rolls back, and is written before its Stretch', () => {
    const { g, lines } = group();
    g.load({
      name: 'a',
      source:
        'script variable n = 0\non go\n  put 1 into n\n  put 2 into n\nend go',
    }).deliver({ name: 'go', limits: { fuelPerRun: 8 } });
    g.pump(clock);
    g.inspect();
    expect(lines.slice(3)).toEqual([
      'fault a/r1 limit=fuel at=a:7 pos=4:3 rollback=[n]',
      'seg a/r1 start delivery=d1 handler=go clause=1 fuel=8 alloc=0 state=16 end=fault',
      'run a/r1 outcome=limit-fault delivery=d1 handler=go limit=fuel fuel=8 alloc=0',
      'pumped state=idle fuel=8',
      '> vars',
      'vars a n=0',
    ]);
  });

  test('a Fuel Slice preempts a Run, which continues in the next Pump, and its overrun is debt', () => {
    const { g, lines } = group();
    const source =
      'on go\n  put 0 into n\n  repeat 5 times\n    add 1 to n\n  end repeat\n  return n\nend go';
    const a = g.load({ name: 'a', source });
    const b = g.load({ name: 'b', source });
    a.deliver({ name: 'go' });
    b.deliver({ name: 'go' });
    expect(g.pump(clock, { fuelSlice: 20 }).state).toBe('sliced');
    expect(lines.filter(line => line.startsWith('preempt'))).toEqual([
      'preempt a/r1 start delivery=d1 handler=go clause=1 by=slice fuel=20 alloc=40',
      'preempt b/r1 start delivery=d2 handler=go clause=1 by=slice fuel=20 alloc=40',
    ]);
    lines.length = 0;
    expect(g.pump(later(1), { fuelSlice: 0 }).state).toBe('idle');
    expect(lines.filter(line => /^(seg|run) /.test(line))).toEqual([
      'seg a/r1 continue fuel=60 alloc=64 state=0 end=return',
      'run a/r1 outcome=completed delivery=d1 handler=go value=5 fuel=80 alloc=104',
      'seg b/r1 continue fuel=60 alloc=64 state=0 end=return',
      'run b/r1 outcome=completed delivery=d2 handler=go value=5 fuel=80 alloc=104',
    ]);
  });

  test("an overrun is carried to the Script's next Pump as debt", () => {
    const { g, lines } = group();
    g.load({ name: 'a', source: 'on go\n  return 1\nend go' }).deliver({
      name: 'go',
    });
    // The first instruction costs 5, the `clause` rate and `const`, against a
    // slice of 1, so 4 is carried as debt.
    g.pump(clock, { fuelSlice: 1 });
    expect(lines.find(line => line.startsWith('preempt'))).toContain('fuel=5');
    // Each later slice pays 1 of it, so four Pumps run nothing.
    for (let i = 1; i <= 4; i++) {
      lines.length = 0;
      expect(g.pump(later(i), { fuelSlice: 1 }).state).toBe('sliced');
      expect(lines.slice(1)).toEqual(['pumped state=sliced fuel=0']);
    }
    lines.length = 0;
    g.pump(later(5), { fuelSlice: 1 });
    expect(lines[1]).toBe(
      'seg a/r1 continue fuel=2 alloc=0 state=0 end=return',
    );
  });

  test('the Fuel cap ends the Pump', () => {
    const { g, lines } = group();
    g.load({
      name: 'a',
      source: 'on go\n  repeat 10 times\n  end repeat\nend go',
    }).deliver({
      name: 'go',
    });
    g.pump(clock, { fuelCap: 10 });
    expect(lines.find(line => line.startsWith('preempt'))).toBe(
      'preempt a/r1 start delivery=d1 handler=go clause=1 by=cap fuel=10 alloc=24',
    );
    expect(lines.at(-1)).toBe('pumped state=sliced fuel=10');
  });
});

describe('a runaway Script', () => {
  test('ends in its own Limit Fault, leaving the other Scripts and its own state intact', async () => {
    const { g, lines } = group();
    const spin = g.load({
      name: 'spin',
      source:
        'script variable n = 0\non go\n  repeat forever\n    add 1 to n\n  end repeat\nend go\non read\n  return n\nend read',
    });
    const steady = g.load({
      name: 'steady',
      source:
        'script variable count = 0\non tick\n  add 1 to count\n  return count\nend tick',
    });
    spin.deliver({ name: 'go', limits: { fuelPerRun: 500 } });
    steady.deliver({ name: 'tick' });
    steady.deliver({ name: 'tick' });
    const first = g.pump(clock).reports;
    expect(
      first.map(
        r =>
          r.kind === 'run end' && [r.script, r.outcome, r.result?.toString()],
      ),
    ).toEqual([
      ['spin', 'limit fault', undefined],
      ['steady', 'completed', '1'],
      ['steady', 'completed', '2'],
    ]);
    // The Segment's writes to `n` are rolled back; nothing else is touched.
    expect(lines.find(l => l.startsWith('fault spin/r1'))).toEndWith(
      'rollback=[n]',
    );
    expect(spin.counters().faults).toBe(1);
    expect(steady.counters().faults).toBe(0);
    // Both Scripts go on running normally.
    const read = spin.request({ name: 'read' });
    steady.deliver({ name: 'tick' });
    const second = g.pump(later(1)).reports;
    expect(
      second.map(
        r =>
          r.kind === 'run end' && [r.script, r.outcome, r.result?.toString()],
      ),
    ).toEqual([
      ['spin', 'completed', '0'],
      ['steady', 'completed', '3'],
    ]);
    expect(await read.result).toEqual(num(0));
    expect(
      g
        .inspect()
        .scripts.map(s => [s.name, s.vars.map(([k, v]) => `${k}=${v}`)]),
    ).toEqual([
      ['spin', ['n=0']],
      ['steady', ['count=3']],
    ]);
  });
});

describe('a Limit Fault', () => {
  test('is never caught: no catch or finally runs, and the Segment rolls back', () => {
    const { g, lines } = group();
    const s = g.load({
      name: 's',
      source:
        'script variable seen = []\non go\n  put "started" after seen\n  try\n    repeat forever\n      put "loop" into last\n    end repeat\n  catch e\n    put "caught" after seen\n  finally\n    put "finally" after seen\n  end try\nend go',
    });
    s.deliver({ name: 'go', limits: { fuelPerRun: 300 } });
    const [end] = g.pump(clock).reports;
    expect(end).toMatchObject({ outcome: 'limit fault', limit: 'fuel' });
    expect(lines.some(l => l.startsWith('raise '))).toBe(false);
    expect(lines.find(l => l.startsWith('fault s/r1'))).toEndWith(
      'rollback=[seen]',
    );
    expect(g.inspect().scripts[0]!.vars.map(([k, v]) => `${k}=${v}`)).toEqual([
      'seen=[]',
    ]);
  });
});

describe('Host errors and refusals', () => {
  test('an override that loosens a limit is refused at the call, with no id', () => {
    const { g, lines } = group();
    const a = g.load({
      name: 'a',
      source: 'on go\nend go',
      limits: { fuelPerRun: 100 },
    });
    expect(() =>
      a.deliver({ name: 'go', limits: { fuelPerRun: 101 } }),
    ).toThrow(HostError);
    expect(lines.slice(1)).toEqual([
      '> deliver to=a message=go limits={fuelPerRun: 101}',
      'refused code="invalid value"',
    ]);
    expect(a.deliver({ name: 'go' })).toBe('d1');
  });

  test('a full mailbox is load shedding at the call', () => {
    const { g, lines } = group();
    const a = g.load({
      name: 'a',
      source: 'on go\nend go',
      limits: { mailboxDepth: 1 },
    });
    a.deliver({ name: 'go' });
    expect(() => a.deliver({ name: 'go' })).toThrow(MailboxFull);
    expect(lines.at(-1)).toBe('refused code="mailbox full"');
  });

  test('a Clock reading earlier than the last is refused', () => {
    const { g } = group();
    g.pump(later(5));
    expect(() => g.pump(clock)).toThrow('clock backwards');
  });

  test('a Host Object id is unique within its kind in a Group', () => {
    const { g } = group();
    const door = defineObjectKind({ name: 'door', props: {} });
    const item = defineObjectKind({ name: 'item', props: {} });
    g.object(door, 'd1', null);
    expect(() => g.object(door, 'd1', null)).toThrow(
      expect.objectContaining({ code: 'duplicate object id' }),
    );
    expect(g.object(item, 'd1', null).id).toBe('d1');
    expect(newGroup({ name: 'other' }).object(door, 'd1', null).id).toBe('d1');
  });

  test('objectById finds a handle by kind and id, disposed or restored', () => {
    const { g } = group();
    const item = defineObjectKind<string | null>({ name: 'item', props: {} });
    const door = defineObjectKind({ name: 'door', props: {} });
    const key = g.object(item, 'key', 'native key');
    const gone = g.object(item, 'gone', null);
    const sameId = g.object(door, 'key', null);
    expect(g.objectById('item', 'key')).toBe(key);
    expect(g.objectById('door', 'key')).toBe(sameId);
    expect(g.objectById('item', 'missing')).toBeUndefined();
    expect(newGroup({ name: 'other' }).objectById('item', 'key')).toBeUndefined();
    g.load({
      name: 's',
      source: 'script variable held = nothing\non go\n  put key into held\nend go',
      objects: { key },
    }).deliver({ name: 'go' });
    g.dispose(gone);
    g.pump(clock);
    expect(g.objectById('item', 'gone')).toBe(gone);

    const { group: restored } = restore(g.save(), {
      name: 'restored',
      libraries: [],
      onMismatch: 'reject',
      grants: () => undefined,
      resolve: (_kind, id) => ({ native: `restored ${id}` }),
    });
    const found = restored.objectById('item', 'key')!;
    expect(found).not.toBe(key);
    expect(found.native).toBe('restored key');
    expect(restored.inspect().scripts[0]!.vars[0]![1]).toBe(found.value);
    expect(restored.objectById('item', 'gone')).not.toBe(gone);
    expect(restored.objectById('item', 'gone')!.id).toBe('gone');
    const decoded = decodeValue(encodeValue(found.value), (kind, id) =>
      restored.objectById(kind, id),
    );
    expect(decoded).toBe(found.value);
  });

  test('Inspect reads Script Variables in declaration order, with no other effect', () => {
    const { g } = group();
    g.load({
      name: 'a',
      source: 'script variable x = 1\nscript variable y = [1]\non go\nend go',
    });
    const seen = g.inspect().scripts[0]!;
    expect(seen.vars.map(([n, v]: [string, Value]) => `${n}=${v}`)).toEqual([
      'x=1',
      'y=[1]',
    ]);
  });
});

test('labelled selectors select clauses and target-first sends return replies', async () => {
  const { g, lines } = group();
  const a = g.load({
    name: 'a',
    source: `on go
  send to b: move 3 to 4 and wait
  return it
end go`,
  });
  g.load({
    name: 'b',
    source: `on move x
  return 99
end move
on move x to y where y = 0
  pass move to
end move
on move x to y
  return x + y
end move`,
  });
  const request = a.request({ name: 'go' });
  await g.pump(clock);
  expect((await request.result).toString()).toBe('7');
  expect(lines.some(line => line.includes('message=move:to:'))).toBe(true);
});

test('Host message selectors reject malformed parts and mismatched arity at the call', () => {
  const { g, lines } = group();
  const s = g.load({ name: 's', source: 'on go\nend go' });
  for (const name of [
    'move:',
    'move:to',
    'move::to:',
    ':to:',
    'move:from:',
    'move:with:',
    'move:in:',
    'all:to:',
    'on:to:',
    'move:_:',
    'move:to:\n',
  ]) {
    for (const input of [
      () => s.deliver({ name, args: [num(1), num(2)] }),
      () => s.request({ name, args: [num(1), num(2)] }),
      () => g.broadcast({ name, args: [num(1), num(2)] }),
    ]) {
      expect(input).toThrow(HostError);
      expect(lines.at(-1)).toBe('refused code="invalid value"');
    }
  }
  expect(() => s.deliver({ name: 'move:to:', args: [num(1)] })).toThrow(
    HostError,
  );
  expect(() =>
    s.deliver({ name: 'move:to:', args: [num(1), num(2), num(3)] }),
  ).toThrow(HostError);
  expect(() =>
    s.deliver({ name: 'move:to:', args: [num(1), num(2)] }),
  ).not.toThrow();
});
