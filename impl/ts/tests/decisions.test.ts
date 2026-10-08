import { operationalReports } from './operational-reports';
import { describe, expect, test } from 'bun:test';
import { defineObjectKind, newGroup, nothing, num, text } from '../src/index';

const now = 0n;

describe('Decisions', () => {
  test('veto runs finally, returns Nothing, and seals between seg and run', async () => {
    const trace: string[] = [];
    const group = newGroup({ name: 'g', trace: line => trace.push(line) });
    const s = group.load({
      name: 's',
      source:
        'script variable checked = 0\non move, deciding\n  try\n    veto "blocked"\n  finally\n    add 1 to checked\n  end try\nend move',
    });
    const d = s.decide({ name: 'move' });
    const pump = group.pump(now);
    expect(await d.decided).toEqual({
      delivery: d.id,
      verdict: 'vetoed',
      vetoes: [{ script: 's', run: 's/r1', reason: text('blocked') }],
      undecided: [],
    });
    expect((await d.decided).vetoes[0]!.reason.toString()).toBe('"blocked"');
    expect(operationalReports(pump.reports).map(r => r.kind)).toEqual([
      'decided',
      'run end',
    ]);
    expect(operationalReports(pump.reports)[1]).toMatchObject({
      outcome: 'completed',
      result: nothing,
    });
    expect(
      group
        .inspect()
        .scripts[0]!.vars.map(([name, value]) => [name, value.toString()]),
    ).toEqual([['checked', '1']]);
    expect(trace.findIndex(l => l.startsWith('decided '))).toBe(
      trace.findIndex(l => l.startsWith('seg ')) + 1,
    );
  });

  test('seals at suspension, while preemption keeps it open', async () => {
    const group = newGroup({ name: 'g' });
    const s = group.load({
      name: 's',
      source: 'on move, deciding\n  wait 1 s\n  throw "later"\nend move',
    });
    const d = s.decide({ name: 'move' });
    expect(
      operationalReports(group.pump(now, { fuelSlice: 1 }).reports),
    ).toEqual([]);
    const pump = group.pump(now);
    expect(operationalReports(pump.reports)).toHaveLength(1);
    expect(await d.decided).toMatchObject({ verdict: 'allowed' });
    expect(
      operationalReports(group.pump(1_000_000_000n).reports)[0],
    ).toMatchObject({
      outcome: 'errored',
    });
  });

  test('pass carries the open Verdict to a parent; veto ends the path', async () => {
    const group = newGroup({ name: 'g' });
    const kind = defineObjectKind<null>({ name: 'piece', props: {} });
    const parent = group.object(kind, 'parent', null);
    const child = group.object(kind, 'child', null);
    group.load({
      name: 'parent',
      owner: parent,
      source: 'on move, deciding\n  veto\nend move',
    });
    group.load({
      name: 'child',
      owner: child,
      source: 'on move, deciding\n  pass move\nend move',
    });
    group.setParent(child, parent);
    const d = group.decide(child, { name: 'move' });
    group.pump(now);
    expect(await d.decided).toMatchObject({
      verdict: 'vetoed',
      vetoes: [{ script: 'parent', run: 'parent/r1', reason: nothing }],
    });
  });

  test('errors and faults before the seal are undecided', async () => {
    const group = newGroup({ name: 'g' });
    const s = group.load({
      name: 's',
      source: 'on move, deciding\n  throw "broken"\nend move',
    });
    const error = s.decide({ name: 'move' });
    const fault = s.decide({ name: 'move', limits: { fuelPerRun: 1 } });
    group.pump(now);
    expect(await error.decided).toMatchObject({
      verdict: 'undecided',
      undecided: [{ script: 's', run: 's/r1', outcome: 'errored' }],
    });
    expect(await fault.decided).toMatchObject({
      verdict: 'undecided',
      undecided: [{ script: 's', run: 's/r2', outcome: 'limit fault' }],
    });
  });

  test('broadcast aggregates every veto in recipient order and allows no recipients', async () => {
    const group = newGroup({ name: 'g' });
    group.load({
      name: 'a',
      source: 'on move, deciding\n  veto "a"\nend move',
    });
    group.load({
      name: 'b',
      source: 'on move, deciding\n  veto "b"\nend move',
    });
    const d = group.decideBroadcast({ name: 'move' });
    const empty = group.decideBroadcast({ name: 'absent' });
    group.pump(now);
    expect(await d.decided).toMatchObject({
      broadcast: d.id,
      verdict: 'vetoed',
      vetoes: [
        { script: 'a', run: 'a/r1', reason: text('a') },
        { script: 'b', run: 'b/r1', reason: text('b') },
      ],
    });
    expect((await d.decided).vetoes.map(v => v.reason.toString())).toEqual([
      '"a"',
      '"b"',
    ]);
    expect(await empty.decided).toMatchObject({
      verdict: 'allowed',
      vetoes: [],
      undecided: [],
    });
  });

  test('a wait for allows a Decision before the deciding handler can veto', async () => {
    const group = newGroup({ name: 'g' });
    const s = group.load({
      name: 's',
      source:
        'on watch\n  wait for move\nend watch\non move, deciding\n  veto "late"\nend move',
    });
    s.deliver({ name: 'watch' });
    group.pump(now);
    const d = s.decide({ name: 'move' });
    group.pump(now);
    expect(await d.decided).toMatchObject({ verdict: 'allowed', vetoes: [] });
  });
});

const codes = (source: string) => {
  try {
    newGroup({ name: 'g' }).load({ name: 's', source });
    return [];
  } catch (error) {
    return (error as { diagnostics: { code: string }[] }).diagnostics.map(
      d => d.code,
    );
  }
};

describe('Decision load checks', () => {
  test('rejects veto outside deciding handlers and in called handlers', () => {
    expect(codes('on move\n  veto\nend move')).toContain(
      'veto outside a decision',
    );
    expect(
      codes('on move, deciding\n  veto\nend move\non start\n  move\nend start'),
    ).toContain('veto outside a decision');
    expect(
      codes(
        'on move, deciding\n  put given\n    veto\n  end given into f\nend move',
      ),
    ).toContain('veto outside a decision');
  });
  test('rejects veto and pass reachable after a possible suspension', () => {
    expect(
      codes('on move, deciding\n  if true then wait 1 s\n  veto\nend move'),
    ).toContain('after a suspension');
    expect(
      codes(
        'on move, deciding\n  repeat 2 times\n    veto\n    wait 1 s\n  end repeat\nend move',
      ),
    ).not.toContain('after a suspension');
    expect(
      codes(
        'on move, deciding\n  repeat 2 times\n    if true then veto\n    wait 1 s\n  end repeat\nend move',
      ),
    ).toContain('after a suspension');
    expect(
      codes('on move, deciding\n  wait 1 s\n  pass move\nend move'),
    ).toContain('after a suspension');
    expect(
      codes(
        'on move, deciding\n  if true then\n    wait 1 s\n    return\n  else\n    veto\n  end if\nend move',
      ),
    ).toEqual([]);
  });
});

describe('Decision error follow-up', () => {
  test('an undecided error queues on error with during, once, after the Verdict', async () => {
    const group = newGroup({ name: 'g' });
    const s = group.load({
      name: 's',
      source:
        'script variable seen = nothing\non move x, deciding\n  throw "broken"\nend move\non error e, during msg\n  put msg into seen\n  throw "handler failed"\nend error',
    });
    const d = s.decide({ name: 'move', args: [num(2)] });
    const pump = group.pump(now);
    expect(await d.decided).toMatchObject({ verdict: 'undecided' });
    expect(operationalReports(pump.reports).map(r => r.kind)).toEqual([
      'run end',
      'decided',
      'run end',
    ]);
    expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe(
      '{name: "move", args: [2]}',
    );
  });
});

describe('Decision boundaries', () => {
  test('dispatch tries guards before allowing an ordinary clause, which can then pass', async () => {
    const trace: string[] = [];
    const group = newGroup({ name: 'g', trace: l => trace.push(l) });
    const s = group.load({
      name: 's',
      source:
        'on move x where false\n  return\nend move\non move x\n  pass move\nend move',
    });
    const d = s.decide({ name: 'move', args: [num(1)] });
    group.pump(now);
    expect(await d.decided).toMatchObject({ verdict: 'allowed' });
    expect(trace.filter(l => l.startsWith('decided '))).toHaveLength(1);
    expect(trace.findIndex(l => l.startsWith('decided '))).toBeLessThan(
      trace.findIndex(l => l.startsWith('seg ')),
    );
  });
  test('a failed finally replaces a planned veto with an undecided error', async () => {
    const group = newGroup({ name: 'g' });
    const s = group.load({
      name: 's',
      source:
        'on move, deciding\n  try\n    veto\n  finally\n    throw "cleanup"\n  end try\nend move',
    });
    const d = s.decide({ name: 'move' });
    group.pump(now);
    expect(await d.decided).toMatchObject({ verdict: 'undecided', vetoes: [] });
  });
  test('broadcast takes late-loaded and waiting recipients, never climbs, and preserves veto precedence', async () => {
    const group = newGroup({ name: 'g' });
    const s = group.load({
      name: 'watcher',
      source: 'on watch\n  wait for move\nend watch',
    });
    s.deliver({ name: 'watch' });
    group.pump(now);
    const d = group.decideBroadcast({ name: 'move' });
    group.load({
      name: 'broken',
      source: 'on move, deciding\n  throw "broken"\nend move',
    });
    group.load({
      name: 'vetoer',
      source: 'on move, deciding\n  veto\nend move',
    });
    const pump = group.pump(now);
    expect(await d.decided).toMatchObject({
      verdict: 'vetoed',
      vetoes: [{ script: 'vetoer', run: 'vetoer/r1', reason: nothing }],
      undecided: [{ script: 'broken', run: 'broken/r1', outcome: 'errored' }],
    });
    expect(
      operationalReports(pump.reports).filter(r => r.kind === 'unhandled'),
    ).toEqual([]);
  });
  test('a Broadcast override caps each recipient without loosening its own limits', async () => {
    const group = newGroup({ name: 'g' });
    group.load({
      name: 's',
      limits: { fuelPerRun: 1 },
      source: 'on move, deciding\n  veto\nend move',
    });
    const d = group.decideBroadcast({
      name: 'move',
      limits: { fuelPerRun: 100 },
    });
    group.pump(now);
    expect(await d.decided).toMatchObject({
      verdict: 'undecided',
      undecided: [{ outcome: 'limit fault' }],
    });
  });
  test('function-style Handler calls cannot reach veto, and veto cannot leave a Join', () => {
    expect(
      codes(
        'on move, deciding\n  veto\nend move\non start\n  put move() into x\nend start',
      ),
    ).toContain('veto outside a decision');
    expect(
      codes(
        'on move, deciding\n  wait for all\n    send query to me and wait\n    veto\n  end wait\nend move\non query\nend query',
      ),
    ).toContain('not in a join');
  });
  test('resume failures in catch paths count as after a suspension, while a throw cannot fall through finally', () => {
    expect(
      codes(
        'on move, deciding\n  try\n    send query to me and wait\n  catch e\n    veto\n  end try\nend move\non query\nend query',
      ),
    ).toContain('after a suspension');
    expect(
      codes(
        'on move, deciding\n  try\n    wait 1 s\n    throw "broken"\n  finally\n    put 1 into x\n  end try\n  veto\nend move',
      ),
    ).toEqual([]);
  });
});

describe('Decision refusals and follow-up errors', () => {
  test('refuses a loosening Broadcast override without consuming its id', async () => {
    const trace: string[] = [];
    const group = newGroup({ name: 'g', trace: l => trace.push(l) });
    expect(() =>
      group.decideBroadcast({ name: 'move', limits: { fuelPerRun: 1e12 } }),
    ).toThrow();
    expect(trace).toEqual([
      '> decide-broadcast message=move limits={fuelPerRun: 1000000000000}',
      'refused code="invalid value"',
    ]);
    const d = group.decideBroadcast({ name: 'move' });
    expect(d.id).toBe('b1');
    group.pump(now);
    expect(await d.decided).toMatchObject({ verdict: 'allowed' });
  });
  test('error clause shorthand matches the code, and during is available to its guard', async () => {
    const group = newGroup({ name: 'g' });
    const s = group.load({
      name: 's',
      source:
        'script variable caught = 0\non move, deciding\n  throw "broken"\nend move\non error "other"\n  add 100 to caught\nend error\non error "broken" where the name of msg = "move", during msg\n  add 1 to caught\nend error',
    });
    const d = s.decide({ name: 'move' });
    group.pump(now);
    expect(await d.decided).toMatchObject({ verdict: 'undecided' });
    expect(
      group
        .inspect()
        .scripts[0]!.vars.map(([name, value]) => [name, value.toString()]),
    ).toEqual([['caught', '1']]);
  });
  test('an unmatched error message is dropped without climbing or another error', () => {
    const group = newGroup({ name: 'g' });
    const s = group.load({
      name: 's',
      source:
        'on move\n  throw "broken"\nend move\non error {code: "other"}\nend error',
    });
    s.deliver({ name: 'move' });
    const pump = group.pump(now);
    expect(operationalReports(pump.reports).map(r => r.kind)).toEqual([
      'run end',
      'run end',
    ]);
  });
});

describe('Decision review regressions', () => {
  test('a failed Join can reach its catch after the Verdict is sealed', () => {
    expect(
      codes(
        'on move, deciding\n  try\n    wait for all\n      send query to me and wait\n    end wait\n  catch e\n    veto\n  end try\nend move\non query\nend query',
      ),
    ).toContain('after a suspension');
  });
  test('a wait for error observes the failed Run even without an on error clause', () => {
    const group = newGroup({ name: 'g' });
    const s = group.load({
      name: 's',
      source:
        'script variable caught = 0\non watch\n  wait for error e\n  add 1 to caught\nend watch\non move, deciding\n  throw "broken"\nend move',
    });
    s.deliver({ name: 'watch' });
    group.pump(now);
    s.decide({ name: 'move' });
    group.pump(now);
    expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe('1');
  });
  test('dispatch-time allow follows failed Guard records and precedes body records', () => {
    const trace: string[] = [];
    const group = newGroup({ name: 'g', trace: l => trace.push(l) });
    const s = group.load({
      name: 's',
      source:
        'on move where 1 / 0 = 1, deciding\n  veto\nend move\non move\n  return\nend move',
    });
    s.decide({ name: 'move' });
    group.pump(now);
    expect(trace.findIndex(l => l.startsWith('guard-skip '))).toBeLessThan(
      trace.findIndex(l => l.startsWith('decided ')),
    );
    expect(trace.findIndex(l => l.startsWith('decided '))).toBeLessThan(
      trace.findIndex(l => l.startsWith('seg ')),
    );
  });
});

test('Decision overrides refuse fractional milliseconds before allocating ids', () => {
  const group = newGroup({ name: 'g' });
  const s = group.load({ name: 's', source: 'on move, deciding\nend move' });
  expect(() =>
    group.decideBroadcast({ name: 'move', limits: { maxWaitMs: 0.5 } }),
  ).toThrow();
  expect(() =>
    s.decide({ name: 'move', limits: { maxWaitMs: 0.5 } }),
  ).toThrow();
  expect(group.decideBroadcast({ name: 'move' }).id).toBe('b1');
  expect(s.decide({ name: 'move' }).id).toBe('d1');
});
