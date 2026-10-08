import { operationalReports } from './operational-reports';
import { describe, expect, test } from 'bun:test';
import {
  compileLibrary,
  defineCapability,
  newGroup,
  num,
  readDisplay,
  type Call,
} from '../src/index';

import { readDisplayText } from '../src/readers';
import { parseRecord } from '../tools/trace-case';

const setup = () => {
  const trace: string[] = [];
  return { g: newGroup({ name: 'g', trace: line => trace.push(line) }), trace };
};
const vars = (g: ReturnType<typeof newGroup>, index = 0) =>
  g
    .inspect()
    .scripts[index]!.vars.map(([name, value]) => [name, value.toString()]);

describe('Reload', () => {
  test('validates before stopping, carries by name, resets when asked, and keeps counters', () => {
    const { g, trace } = setup();
    const s = g.load({
      name: 's',
      source:
        'script variable n = 3\nscript variable old = 9\non go\n  put n + 1 into n\n  wait 1 s\nend go',
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    expect(() =>
      s.reload('script variable n = <50 digits>', 'carry variables'),
    ).not.toThrow();
    // A new source replaces all old definitions, and same-name values carry as-is.
    expect(vars(g)).toEqual([['n', '4']]);
    const reports = s.reload(
      'script variable n = 8\nscript variable fresh = 2\non go\n  return n + fresh\nend go',
      'carry variables',
    );
    expect(operationalReports(reports)).toMatchObject([
      { kind: 'stop', reason: 'reload' },
    ]);
    expect(vars(g)).toEqual([
      ['n', '4'],
      ['fresh', '2'],
    ]);
    s.deliver({ name: 'go' });
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { run: 's/r2', outcome: 'completed' },
    ]);
    s.reload('script variable n = 8', 'reset variables');
    expect(vars(g)).toEqual([['n', '8']]);
    expect(trace.filter(l => l.startsWith('> reload'))).toHaveLength(3);
  });

  test('a load error leaves suspended work and state untouched', () => {
    const { g, trace } = setup();
    const s = g.load({
      name: 's',
      limits: { patternSize: 50 },
      source:
        'script variable n = 1\non go\n  wait 1 s\n  put 2 into n\nend go',
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    expect(() =>
      s.reload('script variable p = <50 digits>', 'carry variables'),
    ).toThrow('pattern too large');
    expect(trace.some(l => l.startsWith('stopped '))).toBe(false);
    g.pump(1_000_000_000n);
    expect(vars(g)).toEqual([['n', '2']]);
  });

  test('successful reload abandons calls without finally and settles senders and Decisions', async () => {
    const { g, trace } = setup();
    let pending!: Call<unknown>;
    const api = defineCapability('api', {
      hold: {
        mode: 'suspending',
        cost: { fuel: 0 },
        start: c => {
          pending = c;
        },
      },
    });
    const s = g.load({
      name: 's',
      grants: { api: api.grant('all', undefined) },
      source:
        'script variable n = 1\non go\n  try\n    ask api to hold and wait\n  finally\n    put 9 into n\n  end try\nend go',
    });
    const r = s.request({ name: 'go' });
    g.pump(0n);
    const d = s.decide({ name: 'go' });
    // Queued Host Inputs have not joined the mailbox: they will use the new code.
    const reports = s.reload(
      'script variable n = 2\non go, deciding\n  veto "new"\nend go',
      'carry variables',
    );
    expect(operationalReports(reports)).toMatchObject([
      { kind: 'stop', discardedRuns: ['s/r1'], pendingCalls: ['s/r1.c1'] },
    ]);
    expect(pending.signal.aborted).toBe(true);
    expect(r.result).rejects.toThrow('stopped');
    g.pump(0n);
    expect(await d.decided).toMatchObject({ verdict: 'vetoed' });
    expect(vars(g)).toEqual([['n', '1']]);
    expect(trace.find(l => l.startsWith('stopped '))).toContain(
      'reason="reload"',
    );
  });

  test('carrying state over the cap rejects without disturbing the old Script', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      limits: { persistentState: 100 },
      source: 'script variable n = "abcdefghij"\non go\n  return n\nend go',
    });
    expect(() =>
      s.reload(
        'script variable n = ""\nscript variable fresh = "' +
          'x'.repeat(80) +
          '"',
        'carry variables',
      ),
    ).toThrow('state too large');
    expect(vars(g)).toEqual([['n', '"abcdefghij"']]);
  });

  test('carried Function Values become stale even after an identical-source reload', () => {
    const { g } = setup();
    const source =
      'script variable callback = nothing\non make\n  put (given x: x + 1) into callback\nend make\non useit\n  return callback(2)\nend useit';
    const s = g.load({ name: 's', source });
    s.deliver({ name: 'make' });
    g.pump(0n);
    s.reload(source, 'carry variables');
    s.deliver({ name: 'useit' });
    const r = operationalReports(g.pump(0n).reports)[0]!;
    expect(r).toMatchObject({ outcome: 'errored' });
    expect('error' in r && r.error!.code).toBe('function gone');
    s.deliver({ name: 'make' });
    g.pump(0n);
    s.deliver({ name: 'useit' });
    const good = operationalReports(g.pump(0n).reports)[0]!;
    expect('result' in good && good.result!.toString()).toBe(num(3).toString());
  });
});

describe('Extend', () => {
  test('adds a separate unit, resolves existing names, preserves Runs and Function Values', () => {
    const { g, trace } = setup();
    const s = g.load({
      name: 's',
      source:
        'script variable n = 1\nscript variable callback = nothing\nconstant offset = 2\nfunction plus x, y = 3\n  return x + y + offset\nend plus\non old\n  put (given x: plus(x)) into callback\n  wait 1 s\n  put n + 1 into n\nend old',
    });
    s.deliver({ name: 'old' });
    g.pump(0n);
    s.extend(
      'script variable fresh = offset + 5\non newone\n  put callback(fresh) into n\n  return n\nend newone',
    );
    expect(vars(g)).toEqual([
      ['n', '1'],
      ['callback', '<function s:8:8>'],
      ['fresh', '7'],
    ]);
    s.deliver({ name: 'newone' });
    const r = operationalReports(g.pump(0n).reports)[0]!;
    expect('result' in r && r.result!.toString()).toBe('12');
    g.pump(1_000_000_000n);
    expect(vars(g)[0]).toEqual(['n', '13']);
    expect(trace.some(l => l.startsWith('stopped '))).toBe(false);
    expect(trace.find(l => l.startsWith('> extend'))).toContain('identity=');
  });

  test('rejects reused names atomically, checks old Handler suspension, and allows multiple new clauses', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      source: 'script variable n = 1\non hold\n  wait 1 s\nend hold',
    });
    expect(() =>
      s.extend('script variable fresh = 2\non hold\nend hold'),
    ).toThrow('name reused');
    expect(() => s.extend('on later\n  hold\nend later')).toThrow(
      'missing and wait',
    );
    expect(vars(g)).toEqual([['n', '1']]);
    s.extend(
      'on later 1\n  hold and wait\nend later\non later value\n  return value\nend later',
    );
    s.deliver({ name: 'later', args: [num(2)] });
    const r = operationalReports(g.pump(0n).reports)[0]!;
    expect('result' in r && r.result!.toString()).toBe('2');
  });

  test('new variables survive rollback of an older preempted Segment', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      source:
        'script variable n = 1\non old\n  put 2 into n\n  repeat forever\n    put n + 1 into n\n  end repeat\nend old',
    });
    s.deliver({ name: 'old' });
    g.pump(0n, { fuelCap: 15 });
    s.extend('script variable fresh = 7');
    s.cancelRun('s/r1');
    g.pump(0n);
    expect(vars(g)).toEqual([
      ['n', '1'],
      ['fresh', '7'],
    ]);
  });

  test('extensions can import Libraries and use their own wait-for event code', () => {
    const { g } = setup();
    const s = g.load({ name: 's', source: 'script variable n = 1' });
    s.extend(
      'use sum from list\non later\n  wait for\n    when answer x where x > 2 then\n      put sum([1]) into n\n  end wait\nend later',
    );
    s.deliver({ name: 'later' });
    g.pump(0n);
    s.deliver({ name: 'answer', args: [num(3)] });
    g.pump(0n);
    expect(vars(g)).toEqual([['n', '1']]);
    expect(g.inspect().scripts[0]!.runs).toEqual([]);
  });
});

describe('Library replacement', () => {
  test('recompiles transitive importers and all extensions atomically, with carry and stable order', () => {
    const { g } = setup();
    const old = compileLibrary({
      name: 'base',
      version: '1',
      source: 'function count\n  return 1\nend count',
    });
    const middle = compileLibrary(
      {
        name: 'middle',
        version: '1',
        source:
          'use count from base\nfunction total\n  return count() + 10\nend total',
      },
      [old],
    );
    g.addLibrary(old);
    g.addLibrary(middle);
    const a = g.load({
      name: 'a',
      source:
        'use total from middle\nscript variable n = 5\non go\n  wait 1 s\n  return total() + n\nend go',
    });
    const b = g.load({ name: 'b', source: 'script variable n = 2' });
    b.extend(
      'use count from base\nscript variable extra = 3\non go\n  return count() + n + extra\nend go',
    );
    a.deliver({ name: 'go' });
    g.pump(0n);
    const replacement = compileLibrary({
      name: 'base',
      version: '2',
      source: 'function count\n  return 7\nend count',
    });
    const replacementReports = g.replaceLibrary(replacement, 'carry variables');
    expect(
      replacementReports.find(r => r.kind === 'run discarded'),
    ).toMatchObject({ run: 'a/r1', reason: 'library replacement' });
    expect(
      replacementReports.find(r => r.kind === 'run accounting'),
    ).toMatchObject({ run: 'a/r1', state: 'discarded' });
    expect(operationalReports(replacementReports)).toMatchObject([
      { kind: 'stop', script: 'a', discardedRuns: ['a/r1'] },
      { kind: 'stop', script: 'b' },
    ]);
    expect(vars(g, 1)).toEqual([
      ['n', '2'],
      ['extra', '3'],
    ]);
    a.deliver({ name: 'go' });
    b.deliver({ name: 'go' });
    const r = operationalReports(g.pump(0n).reports)[0]!;
    expect('result' in r && r.result!.toString()).toBe('12');
    const later = operationalReports(g.pump(1_000_000_000n).reports)[0]!;
    expect('result' in later && later.result!.toString()).toBe('22');
  });

  test('a failed importer leaves every Script and Library registration unchanged', () => {
    const { g, trace } = setup();
    const old = compileLibrary({
      name: 'base',
      version: '1',
      source: 'function count\n  return 1\nend count',
    });
    g.addLibrary(old);
    const a = g.load({
      name: 'a',
      source:
        'use count from base\non go\n  wait 1 s\n  return count()\nend go',
    });
    a.deliver({ name: 'go' });
    g.pump(0n);
    const bad = compileLibrary({
      name: 'base',
      version: '2',
      source: 'function other\n  return 2\nend other',
    });
    expect(() => g.replaceLibrary(bad, 'carry variables')).toThrow(
      'unknown import',
    );
    expect(trace.some(l => l.startsWith('stopped '))).toBe(false);
    const r = operationalReports(g.pump(1_000_000_000n).reports)[0]!;
    expect('result' in r && r.result!.toString()).toBe('1');
    const next = g.load({
      name: 'next',
      source: 'use count from base\non go\n  return count()\nend go',
    });
    next.deliver({ name: 'go' });
    const good = operationalReports(g.pump(1_000_000_000n).reports)[0]!;
    expect('result' in good && good.result!.toString()).toBe('1');
  });
});

describe('code-change boundaries', () => {
  test('extension Function Values use their unit in display, share live variables, and link old defaults', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      source:
        'script variable n = 2\nfunction plus x, y = 3\n  return x + y\nend plus',
    });
    s.extend(
      'script variable f = (given x: x + n)\nscript variable named = nothing\non one\n  put plus into named\n  put 4 into n\n  return f(named(1))\nend one',
    );
    expect(vars(g).map(v => v[1])).toEqual([
      '2',
      '<function s+1:1:22>',
      'nothing',
    ]);
    s.deliver({ name: 'one' });
    const r = operationalReports(g.pump(0n).reports)[0]!;
    expect('result' in r && r.result!.toString()).toBe('8');
    s.extend('on two\n  return f(2)\nend two');
    s.deliver({ name: 'two' });
    const later = operationalReports(g.pump(0n).reports)[0]!;
    expect('result' in later && later.result!.toString()).toBe('6');
  });

  test('a refused extension cannot exceed the kept-state cap or consume its unit number', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      limits: { persistentState: 100 },
      source: 'script variable n = "abcdefghij"',
    });
    expect(() =>
      s.extend('script variable fresh = "' + 'x'.repeat(80) + '"'),
    ).toThrow('state too large');
    expect(vars(g)).toEqual([['n', '"abcdefghij"']]);
    s.extend('on go\n  return 1 / 0\nend go');
    s.deliver({ name: 'go' });
    const r = operationalReports(g.pump(0n).reports)[0]!;
    expect('error' in r && r.error!.data.get('at').get('unit').toString()).toBe(
      '"s+1"',
    );
  });

  test('replacement rejects a new import cycle before changing any Library', () => {
    const { g } = setup();
    const base = compileLibrary({
      name: 'base',
      version: '1',
      source: 'function count\n  return 1\nend count',
    });
    const middle = compileLibrary(
      {
        name: 'middle',
        version: '1',
        source:
          'use count from base\nfunction total\n  return count()\nend total',
      },
      [base],
    );
    g.addLibrary(base);
    g.addLibrary(middle);
    const cycle = compileLibrary(
      {
        name: 'base',
        version: '2',
        source:
          'use total from middle\nfunction count\n  return total()\nend count',
      },
      [middle],
    );
    expect(() => g.replaceLibrary(cycle, 'reset variables')).toThrow(
      'import cycle',
    );
    const s = g.load({
      name: 's',
      source: 'use total from middle\non go\n  return total()\nend go',
    });
    s.deliver({ name: 'go' });
    const r = operationalReports(g.pump(0n).reports)[0]!;
    expect('result' in r && r.result!.toString()).toBe('1');
  });
});

describe('review regressions', () => {
  test('replacement measures carried values after replaying every extension initialiser', () => {
    const { g } = setup();
    const old = compileLibrary({
      name: 'base',
      version: '1',
      source: 'constant start = ""',
    });
    g.addLibrary(old);
    const s = g.load({
      name: 's',
      limits: { persistentState: 100 },
      source: 'script variable n = ""',
    });
    s.extend('use start from base\nscript variable fresh = start');
    const next = compileLibrary({
      name: 'base',
      version: '2',
      source: 'constant start = "' + 'x'.repeat(150) + '"',
    });
    expect(() => g.replaceLibrary(next, 'carry variables')).not.toThrow();
    expect(vars(g)).toEqual([
      ['n', '""'],
      ['fresh', '""'],
    ]);
  });

  test('Script names remain unresolved receiver names and cannot replace existing definitions', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      source: 'script variable n = 5\nscript variable s = 7',
    });
    g.load({ name: 'n', source: '' });
    s.extend('on go\n  return n + s\nend go');
    s.deliver({ name: 'go' });
    let r = operationalReports(g.pump(0n).reports)[0]!;
    expect('result' in r && r.result!.toString()).toBe('12');
    s.reload(
      'script variable n = 1\nscript variable s = 2\non go\n  return n + s\nend go',
      'carry variables',
    );
    s.deliver({ name: 'go' });
    r = operationalReports(g.pump(0n).reports)[0]!;
    expect('result' in r && r.result!.toString()).toBe('12');
  });

  test('extension calls into older vetoing Handlers are rejected at their veto', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      source: 'on decideit, deciding\n  veto "no"\nend decideit',
    });
    expect(() => s.extend('on caller\n  decideit\nend caller')).toThrow(
      'veto outside a decision',
    );
    expect(() =>
      s.extend('on caller\n  return decideit()\nend caller'),
    ).toThrow('veto outside a decision');
    expect(g.inspect().scripts[0]!.vars).toEqual([]);
  });

  test('initializer-created values from different code are unequal, while extension preserves old literal equality', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      source:
        'script variable f = (given x: x + 1)\non getit\n  return f\nend getit',
    });
    s.deliver({ name: 'getit' });
    const old = operationalReports(g.pump(0n).reports)[0]!;
    s.reload(
      'script variable f = (given x: x + 2)\non getit\n  return f\nend getit',
      'reset variables',
    );
    s.deliver({ name: 'getit' });
    const fresh = operationalReports(g.pump(0n).reports)[0]!;
    expect(
      'result' in old && 'result' in fresh && old.result!.equals(fresh.result!),
    ).toBe(false);
    s.reload(
      'script variable f = nothing\nfunction increment x\n  return x + 1\nend increment\non same\n  return f is increment\nend same\non named\n  put increment into f\nend named',
      'reset variables',
    );
    s.deliver({ name: 'named' });
    s.deliver({ name: 'same' });
    let r = operationalReports(g.pump(0n).reports)[1]!;
    expect('result' in r && r.result!.toString()).toBe('true');
    s.extend('on fresh\n  return 1\nend fresh');
    s.deliver({ name: 'same' });
    r = operationalReports(g.pump(0n).reports)[0]!;
    expect('result' in r && r.result!.toString()).toBe('true');
  });

  test('named extension functions display their Home Script, while Lambdas display the extension unit', () => {
    const { g } = setup();
    const s = g.load({ name: 's', source: '' });
    s.extend(
      'function plus x\n  return x + 1\nend plus\non getfn\n  return [plus, (given x: x + 1)]\nend getfn',
    );
    s.deliver({ name: 'getfn' });
    const r = operationalReports(g.pump(0n).reports)[0]!;
    expect('result' in r && r.result!.toString()).toBe(
      '[<function s:plus>, <function s+1:5:18>]',
    );
  });
});

test('code-change source fields use the display form and replay embedded quotes and newlines', () => {
  const { g, trace } = setup();
  const s = g.load({ name: 's', source: '' });
  const source =
    'script variable caption = "hello"\non go\n  return caption\nend go';
  s.extend(source);
  const record = parseRecord(trace.find(l => l.startsWith('> extend'))!);
  expect(readDisplay(record.fields.get('source')!).asText()).toBe(source);
});

test('source replay preserves the scalar sequence its code identity hashes', () => {
  const { g, trace } = setup();
  const s = g.load({ name: 's', source: '' });
  const source = 'script variable caption = "e\u0301"';
  s.extend(source);
  const record = parseRecord(trace.find(l => l.startsWith('> extend'))!);
  expect(readDisplayText(record.fields.get('source')!)).toBe(source);
  expect(vars(g)).toEqual([['caption', '"é"']]);
});
