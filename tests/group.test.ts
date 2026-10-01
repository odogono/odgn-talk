import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  codeIdentity,
  HostError,
  LoadError,
  MailboxFull,
  newGroup,
  parseInstant,
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
        `odgn-talk code identity 1\n1.0-rc\n0\nscript\na\nsource\n${source}`,
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
});

describe('Deliveries and Pumps', () => {
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
