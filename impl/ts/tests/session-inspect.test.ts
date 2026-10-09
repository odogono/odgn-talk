import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SessionHost,
  parseTranscript,
  replayTranscript,
  writeTranscript,
  type TranscriptItem,
} from '../src/session';
import { replayTrace } from '../src/replay';
import { ScriptError } from '../src/errors';
import { shape } from '../src/capabilities';
import { dec, text, map, nothing } from '../src/values';
import type { SessionObjects } from '../src/session/objects';

test('inspection reports expression diagnostics at their own positions without executing', () => {
  const trace: string[] = [];
  const host = new SessionHost({ now: () => 0n, trace: l => trace.push(l) });
  host.input('script variable calls = 0');
  host.input('function once\nadd 1 to calls\nreturn 1\nend once');
  const source = host.source;
  const before = [...trace];
  for (const { input, diagnostic } of [
    { input: ':inspect given x => x', diagnostic: '! unexpected token at 1:9' },
    {
      input: ':inspect [\n  1,\n  )]',
      diagnostic: '! unexpected token at 3:3',
    },
    { input: ':inspect once() + )', diagnostic: '! unexpected token at 1:10' },
    { input: ':inspect 1 + @', diagnostic: '! bad character at 1:5' },
    {
      input: ':inspect "unfinished',
      diagnostic: '! unterminated text at 1:1',
    },
    { input: ':inspect 1 +', diagnostic: '! unexpected token at 1:4' },
  ]) {
    expect(host.input(input)).toEqual([diagnostic]);
  }
  for (const input of [
    ':inspect put once() into calls',
    ':inspect constant wrong = once()',
    ':inspect once() 2',
    ':inspect once()\n2',
    ':inspect once() -- trailing comment\n\n2',
  ]) {
    expect(host.input(input)).toEqual(['! bad arguments']);
  }
  expect(host.source).toBe(source);
  expect(trace).toEqual(before);
  expect(host.input('calls')).toEqual(['0']);
});

test('inspection renders an anonymous Lambda with no name or documentation', () => {
  const host = new SessionHost({ now: () => 0n });
  expect(host.input(':inspect given x: x')).toEqual([
    'value {kind: "function", value: <function session+1:2:8>}',
    'function {name: nothing, arity: 1..1, home: "session"}',
    'doc ""',
  ]);
});

test('describe shares passive Object metadata and records its single snapshot exposures', () => {
  const items: TranscriptItem[] = [];
  const trace: string[] = [];
  let reads = 0;
  const host = new SessionHost({
    now: () => 0n,
    record: item => items.push(item),
    trace: line => trace.push(line),
    objects: c => ({
      thing: c.object(
        c.defineKind({
          name: 'thing',
          props: {
            x: {
              get: () => {
                reads++;
                return dec('3');
              },
            },
          },
        }),
        '1',
        {},
      ),
    }),
  });
  host.input('put thing into held');
  host.input(':describe min');
  const before = trace.filter(line => line.startsWith('> vars')).length;
  const rows = host.input(':describe held');
  expect(reads).toBe(0);
  expect(rows).toContain('object {kind: "thing", id: "1", disposed: false}');
  expect(rows.some(line => line.startsWith('property {name: "x"'))).toBe(true);
  expect(trace.filter(line => line.startsWith('> vars'))).toHaveLength(
    before + 1,
  );
  host.input('put lambda x => x into callback');
  host.input(':describe callback');
  host.input(':vars');
  expect(writeTranscript(replayTranscript(items).items)).toBe(
    writeTranscript(items),
  );
  for (const restoreBetweenPumps of [false, true]) {
    const driver = replayTrace(() => '', host.setup, trace, {
      restoreBetweenPumps,
    });
    let result = driver.next();
    while (!result.done) {
      result = driver.next();
    }
    expect(result.value).toEqual(trace);
  }
});

test('inspection executes once, renders passive rows and never allocates a scalar reader', () => {
  const trace: string[] = [];
  const host = new SessionHost({ now: () => 0n, trace: l => trace.push(l) });
  host.input('script variable calls = 0');
  host.input(
    'function once\nadd 1 to calls\nreturn {z: [1], a: "é"}\nend once',
  );
  expect(host.input(':inspect once()')).toEqual([
    'value {kind: "map", value: {z: [1], a: "é"}}',
    'size 2',
    'field "a" = "é"',
    'field "z" = [1]',
  ]);
  expect(host.input('calls')).toEqual(['1']);
  expect(trace.filter(l => l.startsWith('> request '))).toHaveLength(2);
  for (const input of [
    ':inspect put 1 into calls',
    ':inspect script variable wrong = 1',
    ':inspect 1\n2',
  ]) {
    expect(host.input(input)).toEqual(['! bad arguments']);
  }
  expect(host.source).not.toContain('wrong');
  expect(host.incomplete(':inspect [\n1,')).toBe(true);
});

test('object callbacks, queued actions, nested functions and resolver outcomes replay in both Trace modes', () => {
  const items: TranscriptItem[] = [];
  const trace: string[] = [];
  let context!: SessionObjects;
  let calls = 0;
  let held = nothing;
  let sourceCalled = false;
  const host = new SessionHost({
    now: () => 0n,
    record: i => items.push(i),
    trace: l => trace.push(l),
    objects: c => {
      context = c;
      const childKind = c.defineKind({
        name: 'InspectChild',
        props: {
          value: {
            get: () => {
              calls++;
              return dec('9');
            },
          },
        },
      });
      const rootKind = c.defineKind({
        name: 'InspectRoot',
        props: {
          callback: {
            get: () => held,
            set: (_o, v) => {
              held = v;
            },
            shape: shape.value,
            getCost: { fuel: 2 },
            setCost: { fuel: 3 },
          },
          child: { get: () => c.object(childKind, 'dynamic', {}).value },
          error: {
            get: () => {
              c.action({
                kind: 'set-parent',
                object: { kind: 'InspectRoot', id: 'root' },
                parent: { kind: 'InspectRoot', id: 'root' },
              });
              c.action({
                kind: 'deliver',
                to: { script: 'session' },
                message: { name: 'notice', args: [] },
              });
              throw new ScriptError(
                'getter refused',
                'private detail',
                map([['detail', text('safe')]]),
              );
            },
          },
          shape: { shape: shape.number, get: () => text('wrong') },
          z: {
            get: () =>
              map([
                ['z', dec('2')],
                ['a', dec('1')],
                ['$sessionFunction', text('ordinary')],
              ]),
          },
        },
      });
      return { root: c.object(rootKind, 'root', {}) };
    },
    resolveObject: (kind, id) =>
      kind === 'InspectRoot' && id === 'root' ? { native: {} } : undefined,
  });
  for (const source of [
    'on notice\nsay "%notice"\nend notice',
    '--| Original.\nfunction plus x = 1\nreturn x + 1\nend plus',
    ':inspect plus',
    'set the callback of root to {z: [plus], a: 7}',
    ':inspect root',
    ':vars',
    ':save s',
    ':inspect the child of root',
    ':restore s',
    ':inspect root',
    ':inspect the child of root',
    ':inspect {z: 1, a: 2}',
    ':inspect given x: x',
    ':inspect given x => x',
    ':inspect "é"',
    ':inspect 1\n2',
    ':vars',
  ]) {
    host.input(source);
    if (source === ':inspect root' && calls === 0 && !sourceCalled) {
      sourceCalled = true;
      context.action({
        kind: 'call',
        fn: held.get('z').index(1),
        args: [dec('4')],
      });
      host.tick();
      context.action({
        kind: 'set-parent',
        object: { kind: 'InspectChild', id: 'dynamic' },
        parent: { kind: 'InspectRoot', id: 'root' },
      });
      context.action({
        kind: 'set-parent',
        object: { kind: 'InspectChild', id: 'dynamic' },
        parent: null,
      });
      host.tick();
    }
    if (source === ':inspect the child of root' && calls === 1) {
      context.action({
        kind: 'dispose',
        object: { kind: 'InspectChild', id: 'dynamic' },
      });
      host.tick();
    }
  }
  expect(calls).toBe(1); // nested child was read only by its own explicit inspection
  const live = writeTranscript(items);
  const replayed = replayTranscript(parseTranscript(live), { trace: () => {} });
  expect(writeTranscript(replayed.items)).toBe(live);
  expect(live).toContain('"$sessionFunction"');
  expect(host.input('say "%output"').at(-1)).toEqual('%output');
  expect(writeTranscript(items)).toContain("'%output");
  expect(live).toContain(
    'error: {code: "getter refused", detail: "safe", capability: "InspectRoot", operation: "error"}',
  );
  for (const restoreBetweenPumps of [false, true]) {
    const driver = replayTrace(() => '', host.setup, trace, {
      restoreBetweenPumps,
    });
    let result = driver.next();
    while (!result.done) {
      result = driver.next();
    }
    expect(result.value).toEqual(trace);
  }
  // External actions are recorded and reproduce synchronous refusal too.
  expect(
    context.action({
      kind: 'set-parent',
      object: { kind: 'InspectRoot', id: 'root' },
      parent: { kind: 'InspectRoot', id: 'root' },
    }),
  ).toEqual({ error: 'parent cycle' });
});

test('later Limit Faults retain earlier reader output and pre-callback faults need no envelope', () => {
  const items: TranscriptItem[] = [];
  const host = new SessionHost({
    now: () => 0n,
    record: i => items.push(i),
    objects: c => {
      const kind = c.defineKind({
        name: 'InspectLimit',
        props: {
          a: { get: () => dec('1') },
          z: { getCost: { fuel: 1000 }, get: () => dec('2') },
        },
      });
      return { object: c.object(kind, 'o', {}) };
    },
  });
  host.input(':limits fuelPerRun 250');
  const out = host.input(':inspect object');
  expect(out).toContain('read {name: "a", value: 1}');
  expect(out.at(-1)).toContain('! limit fault fuel');
  expect(
    items.filter(i => i.k === 'envelope' && i.json.includes('property-begin')),
  ).toHaveLength(1);
  expect(writeTranscript(replayTranscript(items).items)).toBe(
    writeTranscript(items),
  );
});

// The normative template is shipped as generated source, including its final LF.
test('reader template bytes are generated directly from the specification', async () => {
  const { inspectReader } = await import('../src/generated/session');
  expect(inspectReader).toBe(
    readFileSync(
      resolve(import.meta.dir, '../../../spec/session/inspect-reader.talk'),
      'utf8',
    ),
  );
});

test('inspection cancellation before dispatch starts no reader and replays the external action before the Clock', () => {
  let context!: SessionObjects;
  let cancel = true;
  const items: TranscriptItem[] = [],
    trace: string[] = [];
  const host = new SessionHost({
    record: i => items.push(i),
    trace: l => trace.push(l),
    objects: c => {
      context = c;
      const kind = c.defineKind({
        name: 'Cancelled',
        props: {
          x: {
            get: () => {
              throw new Error('cancelled getter ran');
            },
          },
        },
      });
      return { object: c.object(kind, 'o', {}) };
    },
    now: () => {
      if (cancel) {
        cancel = false;
        context.action({ kind: 'cancel-delivery', delivery: 'd1' });
      }
      return 0n;
    },
  });
  host.input(':inspect object');
  expect(trace.filter(l => l.startsWith('> request '))).toHaveLength(1);
  expect(
    items.some(i => i.k === 'envelope' && i.json.includes('property-begin')),
  ).toBe(false);
  expect(writeTranscript(replayTranscript(items).items)).toBe(
    writeTranscript(items),
  );
});

test('malformed object recordings fail as Transcript errors, including errors swallowed by the Core callback boundary', () => {
  const items: TranscriptItem[] = [];
  new SessionHost({
    now: () => 0n,
    record: i => items.push(i),
    objects: c => {
      const k = c.defineKind({
        name: 'Malformed',
        props: { x: { get: () => dec('1') } },
      });
      return { object: c.object(k, 'o', {}) };
    },
  }).input(':inspect object');
  const original = writeTranscript(items);
  for (const changed of [
    original.replace('"crossing":1', '"crossing":2'),
    original.replace(
      '"reply":{"value":1}',
      '"reply":{"value":{"$sessionFunction":"f99"}}',
    ),
    original.replace(/% .*"type":"property-end".*\n/u, ''),
    original.replace('"operation":"get"', '"operation":"set"'),
    original.replace('"reply":{"value":1}', '"reply":{"value":{"1":1,"1":2}}'),
    original + '% {"type":"object","object":{"kind":"Malformed","id":"o"}}\n',
  ]) {
    expect(() => replayTranscript(parseTranscript(changed))).toThrow();
  }
});

test('envelope framing rejects duplicate and extra fields, invalid counters and forbidden Host actions', async () => {
  const { parseEnvelope } = await import('../src/session');
  for (const raw of [
    '{"type":"setup","type":"setup","objects":{}}',
    '{"type":"setup","objects":{},"extra":0}',
    '{"type":"object","object":{"kind":"k","id":"i","extra":0}}',
    '{"type":"property-end","crossing":0,"reply":{"ok":true}}',
    '{"type":"property-end","crossing":"1","reply":{"ok":true}}',
    '{"type":"property-end","crossing":9007199254740992,"reply":{"ok":true}}',
    '{"type":"property-end","crossing":1,"reply":{"hostError":false}}',
    '{"type":"property-end","crossing":1,"reply":{"fail":{"code":"x","message":"x","data":{},"extra":1}}}',
    '{"type":"function","handle":"f0","exposure":1,"path":[]}',
    '{"type":"function","handle":"f1","exposure":1,"path":[-1]}',
    '{"type":"input","request":{"kind":"pump"},"reply":{"ok":{}}}',
    '{"type":"input","request":{"kind":"deliver","to":{"script":"session"},"message":{"name":"x","args":false}},"reply":{"ok":{}}}',
    '{"type":"input","request":{"kind":"decide","broadcast":false,"message":{"name":"x"}},"reply":{"ok":{}}}',
    '{"type":"input","request":{"kind":"call","fn":null,"args":[],"limits":{"extra":1}},"reply":{"ok":{}}}',
    '{"type":"input","request":{"kind":"answer","call":"c","value":null,"fuel":-1},"reply":{"ok":{}}}',
    '{"type":"input","request":{"kind":"settle","call":"c","settlement":{"adopt":false}},"reply":{"ok":{}}}',
    '{"type":"resolve","objects":[{"object":{"kind":"k","id":"i"},"resolved":1}]}',
  ]) {
    expect(() => parseEnvelope(raw)).toThrow();
  }
  expect(
    parseEnvelope(
      '{"type":"property-end","crossing":"9007199254740992","reply":{"ok":true}}',
    ).crossing,
  ).toBe('9007199254740992');
});

test('disposal between expression and reader uses the retained object, with no fabricated callbacks', () => {
  const items: TranscriptItem[] = [];
  let context!: SessionObjects;
  let calls = 0,
    pumps = 0;
  const host = new SessionHost({
    record: i => items.push(i),
    objects: c => {
      context = c;
      const k = c.defineKind({
        name: 'Disposed',
        props: {
          x: {
            get: () => {
              calls++;
              return dec('1');
            },
          },
        },
      });
      return { object: c.object(k, 'o', {}) };
    },
    now: () => {
      if (++pumps === 2) {
        context.action({
          kind: 'dispose',
          object: { kind: 'Disposed', id: 'o' },
        });
      }
      return 0n;
    },
  });
  const out = host.input(':inspect object');
  expect(calls).toBe(0);
  expect(out.at(-1)).toContain('object gone');
  expect(
    items.some(i => i.k === 'envelope' && i.json.includes('property-begin')),
  ).toBe(false);
  expect(writeTranscript(replayTranscript(items).items)).toBe(
    writeTranscript(items),
  );
});

test('external Function calls accepted before Save remain queued across Restore in independent Trace replay', () => {
  const items: TranscriptItem[] = [],
    trace: string[] = [];
  let context!: SessionObjects,
    held = nothing;
  const host = new SessionHost({
    now: () => 0n,
    record: i => items.push(i),
    trace: l => trace.push(l),
    resolveObject: () => ({ native: {} }),
    objects: c => {
      context = c;
      const k = c.defineKind({
        name: 'QueuedFunction',
        props: {
          callback: {
            shape: shape.value,
            get: () => held,
            set: (_o, v) => {
              held = v;
            },
          },
        },
      });
      return { object: c.object(k, 'o', {}) };
    },
  });
  host.input('function plus x\nreturn x + 1\nend plus');
  host.input('set the callback of object to plus');
  context.action({ kind: 'call', fn: held, args: [dec('4')] });
  host.input(':save s');
  host.tick();
  host.input(':restore s');
  host.tick();
  host.input(':vars');
  expect(writeTranscript(replayTranscript(items).items)).toBe(
    writeTranscript(items),
  );
  for (const restoreBetweenPumps of [false, true]) {
    const driver = replayTrace(() => '', host.setup, trace, {
      restoreBetweenPumps,
    });
    let result = driver.next();
    while (!result.done) {
      result = driver.next();
    }
    expect(result.value).toEqual(trace);
  }
});
