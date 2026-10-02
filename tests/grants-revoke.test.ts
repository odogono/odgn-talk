import { expect, test } from 'bun:test';
import {
  compileLibrary,
  defineCapability,
  HostError,
  LoadError,
  newGroup,
  num,
  restore,
  shape,
  type Call,
} from '../src/index';

const source = 'on go\n  ask io to read\n  return it\nend go';
const capability = () =>
  defineCapability<string>('store', {
    read: {
      mode: 'immediate',
      result: shape.number,
      cost: { fuel: 1 },
      do: () => num(7),
    },
    write: {
      mode: 'fire-and-forget',
      args: [shape.text],
      cost: { fuel: 1 },
      fire: () => {},
    },
  });
const codes = (work: () => unknown) => {
  try {
    work();
    return [];
  } catch (error) {
    if (!(error instanceof LoadError)) {
      throw error;
    }
    return error.diagnostics.map(d => d.code);
  }
};

test('GrantsAsUsed keeps direct, unused Lambda, say and transitive Library Operations', () => {
  const store = capability();
  const declarations = {
    log: { write: { mode: 'fire-and-forget' as const, args: [shape.text] } },
  };
  const base = compileLibrary(
    {
      name: 'base',
      version: '1',
      source:
        'function label\n  return "ok"\nend label\nprivate on unused\n  tell log to write "hidden"\nend unused',
    },
    [],
    declarations,
  );
  const wrapper = compileLibrary(
    {
      name: 'wrapper',
      version: '1',
      source: 'use label from base\nfunction tag\n  return label()\nend tag',
    },
    [base],
  );
  const g = newGroup({ name: 'g' });
  g.addLibrary(base);
  g.addLibrary(wrapper);
  const s = g.load({
    name: 's',
    source:
      'use tag from wrapper\non unused\n  put (given x\n    ask io to read\n    return it\n  end given) into callback\n  say "hello"\nend unused',
    grantsAsUsed: true,
    grants: {
      io: store.grant('all', 'io'),
      log: store.grant('all', 'log'),
      console: store.grant('all', 'console'),
      spare: store.grant('all', 'spare'),
    },
  });
  expect(s.grants()).toEqual({
    console: ['write'],
    io: ['read'],
    log: ['write'],
  });
});

test('GrantsAsUsed copies the template and matches explicitly restricted Grant fingerprints', () => {
  const store = capability();
  const grant = store.grant('all', 'binding');
  const g = newGroup({ name: 'g' });
  const trimmed = g.load({
    name: 's',
    source,
    grants: { io: grant },
    grantsAsUsed: true,
  });
  expect(trimmed.grants()).toEqual({ io: ['read'] });
  const snapshot = trimmed.grants();
  snapshot.io!.push('write');
  expect(trimmed.grants()).toEqual({ io: ['read'] });
  expect([...grant.ops]).toEqual(['read', 'write']);
  const explicit = newGroup({ name: 'other' });
  explicit.load({
    name: 's',
    source,
    grants: { io: store.grant(['read'], 'elsewhere') },
  });
  expect(g.fingerprint()).toEqual(explicit.fingerprint());
  expect(
    g.load({ name: 'full', source, grants: { io: grant } }).grants(),
  ).toEqual({ io: ['read', 'write'] });
});

test('trimmed Operations cannot be regained by Reload or Extend and invalid calls still reject', () => {
  const store = capability();
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source,
    grants: { io: store.grant('all', '') },
    grantsAsUsed: true,
  });
  const added = 'on writeit\n  tell io to write "new"\nend writeit';
  expect(codes(() => s.extend(added))).toEqual(['unknown operation']);
  expect(codes(() => s.reload(added, 'reset variables'))).toEqual([
    'unknown operation',
  ]);
  expect(s.grants()).toEqual({ io: ['read'] });
  expect(
    codes(() =>
      g.load({ name: 'bad', source, grants: {}, grantsAsUsed: true }),
    ),
  ).toEqual(['unknown operation']);
  expect(
    g
      .load({
        name: 'empty',
        source: 'on go\nend go',
        grants: { io: store.grant('all', '') },
        grantsAsUsed: true,
      })
      .grants(),
  ).toEqual({});
});

test('restoring a trimmed Grant ignores additional rebound Operations and their declarations', () => {
  const store = capability();
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source,
    grants: { io: store.grant('all', '') },
    grantsAsUsed: true,
  });
  const changed = defineCapability('store', {
    read: store.operations.get('read')!,
    write: { mode: 'fire-and-forget', cost: { fuel: 999 }, fire: () => {} },
  });
  const { group: copy, result } = restore(g.save(), {
    name: 'copy',
    libraries: [],
    grants: () => changed.grant('all', ''),
    resolve: () => undefined,
    onMismatch: 'reject',
  });
  expect(result.variablesOnly).toBe(false);
  expect(copy.script('s')!.grants()).toEqual({ io: ['read'] });
  expect(copy.fingerprint()).toEqual(g.fingerprint());
  copy.script('s')!.deliver({ name: 'go' });
  const report = copy.pump(0n).reports[0]!;
  expect('result' in report && report.result?.toString()).toBe('7');
});

test('Revoke drains in order, affects one Script alias and leaves its fingerprint unchanged', () => {
  const store = capability();
  const template = store.grant('all', 'shared');
  const lines: string[] = [];
  const g = newGroup({ name: 'g', trace: line => lines.push(line) });
  const s = g.load({
    name: 's',
    source,
    grants: { io: template, other: template },
  });
  const other = g.load({ name: 'other', source, grants: { io: template } });
  const fingerprint = g.fingerprint();
  s.revoke('io');
  s.revoke('io');
  s.revoke('unknown');
  expect(lines.some(line => line.startsWith('> revoke'))).toBe(false);
  s.deliver({ name: 'go' });
  other.deliver({ name: 'go' });
  const reports = g.pump(0n).reports.filter(r => r.kind === 'run end');
  expect(reports.map(r => r.outcome)).toEqual(['errored', 'completed']);
  expect(reports[0]!.error?.get('code').toString()).toBe(
    '"capability revoked"',
  );
  expect(reports[0]!.error?.get('capability').toString()).toBe('"io"');
  expect(reports[0]!.error?.get('operation').toString()).toBe('"read"');
  expect(s.grants()).toEqual({
    io: ['read', 'write'],
    other: ['read', 'write'],
  });
  expect(g.fingerprint()).toEqual(fingerprint);
  expect([...template.ops]).toEqual(['read', 'write']);
  expect(lines.filter(line => line.startsWith('> revoke'))).toEqual([
    '> revoke s grant=io',
    '> revoke s grant=io',
    '> revoke s grant=unknown',
  ]);
});

test('Revoke queued by an Operation waits for the next Pump', () => {
  const g = newGroup({ name: 'g' });
  let fired = 0;
  const logger = defineCapability('logger', {
    write: {
      mode: 'fire-and-forget',
      cost: { fuel: 1 },
      fire: () => {
        fired++;
        g.script('s')!.revoke('io');
      },
    },
  });
  const s = g.load({
    name: 's',
    source: 'on go\n  tell io to write\n  tell io to write\nend go',
    grants: { io: logger.grant('all', undefined) },
  });
  s.deliver({ name: 'go' });
  expect(g.pump(0n).reports[0]).toMatchObject({ outcome: 'completed' });
  expect(fired).toBe(2);
  s.deliver({ name: 'go' });
  expect(g.pump(1n).reports[0]).toMatchObject({ outcome: 'errored' });
  expect(fired).toBe(2);
});

test('Revoke leaves an in-flight call and its signal live but blocks the next call', () => {
  let pending!: Call<void>;
  let starts = 0;
  const io = defineCapability('io', {
    pause: {
      mode: 'suspending',
      result: shape.number,
      cost: { fuel: 1 },
      start: call => {
        pending = call;
        starts++;
      },
    },
  });
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source: 'on go\n  ask io to pause and wait\n  return it\nend go',
    grants: { io: io.grant('all', undefined) },
  });
  s.deliver({ name: 'go' });
  g.pump(0n);
  s.revoke('io');
  pending.answer(num(8));
  const reports = g.pump(1n).reports.filter(r => r.kind === 'run end');
  expect(reports[0]!.result?.toString()).toBe('8');
  expect(pending.signal.aborted).toBe(false);
  s.deliver({ name: 'go' });
  expect(g.pump(2n).reports[0]).toMatchObject({ outcome: 'errored' });
  expect(starts).toBe(1);
});

test('Reload drops revoked Grants only when it succeeds and Extend rejects new revoked calls', () => {
  const g = newGroup({ name: 'g' });
  const store = capability();
  const s = g.load({
    name: 's',
    source,
    grants: { io: store.grant('all', '') },
  });
  s.revoke('io');
  g.pump(0n);
  const fingerprint = g.fingerprint();
  expect(codes(() => s.reload(source, 'reset variables'))).toEqual([
    'unknown operation',
  ]);
  expect(
    codes(() => s.extend('on later\n  ask io to read\nend later')),
  ).toEqual(['unknown operation']);
  expect(g.fingerprint()).toEqual(fingerprint);
  expect(s.grants()).toEqual({ io: ['read', 'write'] });
  s.deliver({ name: 'go' });
  expect(g.pump(1n).reports[0]).toMatchObject({ outcome: 'errored' });
  s.reload('on go\n  return 3\nend go', 'reset variables');
  expect(s.grants()).toEqual({});
  expect(codes(() => s.reload(source, 'reset variables'))).toEqual([
    'unknown operation',
  ]);
  s.deliver({ name: 'go' });
  const report = g.pump(2n).reports[0]!;
  expect('result' in report && report.result?.toString()).toBe('3');
});

test('Library replacement checks revoked Grants atomically at its Reload boundary', () => {
  const declarations = {
    io: { read: { mode: 'immediate' as const, args: [] } },
  };
  const lib = compileLibrary(
    {
      name: 'helper',
      version: '1',
      source: 'function fetch\n  ask io to read\n  return it\nend fetch',
    },
    [],
    declarations,
  );
  const changed = compileLibrary(
    {
      name: 'helper',
      version: '2',
      source: 'function fetch\n  ask io to read\n  return it + 1\nend fetch',
    },
    [],
    declarations,
  );
  const g = newGroup({ name: 'g' });
  g.addLibrary(lib);
  const s = g.load({
    name: 's',
    source: 'use fetch from helper\non go\n  return fetch()\nend go',
    grants: { io: capability().grant('all', '') },
  });
  s.revoke('io');
  g.pump(0n);
  const fingerprint = g.fingerprint();
  expect(codes(() => g.replaceLibrary(changed, 'reset variables'))).toEqual([
    'missing grant',
  ]);
  expect(g.fingerprint()).toEqual(fingerprint);
  s.reload('on go\nend go', 'reset variables');
  expect(g.replaceLibrary(changed, 'reset variables')).toEqual([]);
  expect(s.grants()).toEqual({});
});

test('queued and applied revocations survive Restore including existing extension calls', () => {
  const store = capability();
  const grant = store.grant('all', '');
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source,
    grants: { io: grant },
    grantsAsUsed: true,
  });
  s.extend('on later\n  ask io to read\nend later');
  s.revoke('io');
  const options = {
    name: 'copy',
    libraries: [],
    grants: () => grant,
    resolve: () => undefined,
    onMismatch: 'reject' as const,
  };
  const { group: copy } = restore(g.save(), options);
  copy.script('s')!.deliver({ name: 'later' });
  expect(copy.pump(0n).reports[0]).toMatchObject({ outcome: 'errored' });
  expect(copy.script('s')!.grants()).toEqual({ io: ['read'] });
  const { group: again } = restore(copy.save(), options);
  again.script('s')!.deliver({ name: 'later' });
  expect(again.pump(1n).reports[0]).toMatchObject({ outcome: 'errored' });
  expect(
    codes(() => again.script('s')!.reload(source, 'reset variables')),
  ).toEqual(['unknown operation']);
  const { group: unbound } = restore(copy.save(), {
    ...options,
    grants: () => undefined,
  });
  unbound.script('s')!.deliver({ name: 'later' });
  expect(unbound.pump(1n).reports[0]).toMatchObject({ outcome: 'errored' });
});

test('Grant inspection is a worker call and rejects Operation reentry', () => {
  const g = newGroup({ name: 'g' });
  const io = defineCapability('io', {
    read: {
      mode: 'immediate',
      cost: { fuel: 1 },
      result: shape.number,
      do: () => {
        expect(() => g.script('s')!.grants()).toThrow(HostError);
        expect(() => g.script('s')!.grants()).toThrow('reentrant call');
        return num(1);
      },
    },
  });
  g.load({
    name: 's',
    source,
    grants: { io: io.grant('all', undefined) },
  }).deliver({ name: 'go' });
  expect(g.pump(0n).reports[0]).toMatchObject({ outcome: 'completed' });
});

test('Grant inspection orders Host names by Unicode code point', () => {
  const fire = {
    mode: 'fire-and-forget' as const,
    cost: { fuel: 0 },
    fire: () => {},
  };
  const io = defineCapability('io', { '\u{10000}': fire, '\uE000': fire });
  const s = newGroup({ name: 'g' }).load({
    name: 's',
    source: 'on go\nend go',
    grants: {
      '\u{10000}': io.grant('all', undefined),
      '\uE000': io.grant('all', undefined),
    },
  });
  expect(Object.keys(s.grants())).toEqual(['\uE000', '\u{10000}']);
  expect(Object.values(s.grants())).toEqual([
    ['\uE000', '\u{10000}'],
    ['\uE000', '\u{10000}'],
  ]);
  const numeric = newGroup({ name: 'numeric' }).load({
    name: 's',
    source: 'on go\nend go',
    grants: {
      '2': io.grant('all', undefined),
      '10': io.grant('all', undefined),
    },
  });
  expect(Object.keys(numeric.grants())).toEqual(['2', '10']);
});

test('Restore retains a __proto__ Grant alias and its revoked placeholder', () => {
  const store = capability();
  const template = store.grant('all', 'binding');
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source: 'on go\n  ask __proto__ to read\n  return it\nend go',
    grants: Object.fromEntries([['__proto__', template]]),
    grantsAsUsed: true,
  });
  const saved = g.save();
  for (const offered of [template, undefined]) {
    const { group: copy } = restore(saved, {
      name: 'copy',
      libraries: [],
      grants: () => offered,
      resolve: () => undefined,
      onMismatch: 'reject',
    });
    expect(Object.keys(copy.script('s')!.grants())).toEqual(['__proto__']);
    copy.script('s')!.deliver({ name: 'go' });
    const report = copy.pump(0n).reports.find(r => r.kind === 'run end')!;
    expect(report.outcome).toBe(offered ? 'completed' : 'errored');
    if (offered) {
      expect(report.result?.toString()).toBe('7');
    } else {
      expect(report.error?.get('code').toString()).toBe('"capability revoked"');
    }
  }
});

test('Restore can reissue a revoked in-flight call only when the Host rebinds its Grant', () => {
  const calls: Call<void>[] = [];
  const io = defineCapability('io', {
    pause: {
      mode: 'suspending',
      result: shape.number,
      cost: { fuel: 1 },
      start: call => {
        calls.push(call);
      },
    },
  });
  const grant = io.grant('all', undefined);
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source: 'on go\n  ask io to pause and wait\n  return it\nend go',
    grants: { io: grant },
  });
  s.deliver({ name: 'go' });
  g.pump(0n);
  s.revoke('io');
  g.pump(1n);
  expect(calls[0]!.signal.aborted).toBe(false);
  const saved = g.save();
  const options = {
    name: 'copy',
    libraries: [],
    grants: () => grant,
    resolve: () => undefined,
    onMismatch: 'reject' as const,
  };
  const { group: copy } = restore(saved, options);
  copy.settle('s/r1.c1', { reissue: true });
  expect(copy.pump(2n).reports).toEqual([]);
  expect(calls.map(call => call.id)).toEqual(['s/r1.c1', 's/r1.c1']);
  calls[1]!.answer(num(9));
  const report = copy.pump(3n).reports.find(r => r.kind === 'run end')!;
  expect(report.result?.toString()).toBe('9');
  copy.script('s')!.deliver({ name: 'go' });
  expect(copy.pump(4n).reports[0]).toMatchObject({ outcome: 'errored' });
  expect(calls).toHaveLength(2);
  const { group: unbound } = restore(saved, {
    ...options,
    grants: () => undefined,
  });
  unbound.settle('s/r1.c1', { reissue: true });
  const failed = unbound.pump(2n).reports.find(r => r.kind === 'run end')!;
  expect(failed.error?.get('code').toString()).toBe('"capability revoked"');
  expect(calls).toHaveLength(2);
});
