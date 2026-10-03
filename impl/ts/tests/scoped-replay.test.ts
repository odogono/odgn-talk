import { expect, test } from 'bun:test';
import { replay, parseRecord, type Setup } from '../tools/trace-case';

const clock = '2026-10-02T00:00:00Z';
const setup = (body: string, segmentBound = false): Setup => ({
  operations: [
    {
      capability: 'resource',
      name: 'open',
      mode: 'immediate',
      args: [],
      result: 'nothing',
      scope: { opens: 'file', abandon: 'close' },
      segmentBound,
    },
    {
      capability: 'resource',
      name: 'close',
      mode: 'immediate',
      args: [],
      result: 'nothing',
      scope: { closes: 'file' },
      segmentBound,
    },
  ],
  scripts: [
    {
      name: 's',
      source: 's.talk',
      text: `on go\n${body}\nend go`,
      grants: { r: { capability: 'resource', ops: 'all' } },
    },
  ],
});
const inputs = ['> load s', '> deliver d1 to=s message=go'];
const operationStubs = [
  '> stub resource.open value=nothing',
  '> stub resource.close value=nothing',
];
const effects = (phase: string, status = 'ok') =>
  `> stub-effect s.r phase=${phase} status=${status}`;

test('Segment lifecycle Stubs drive hooks and effect failure reports', () => {
  const lines = replay('', setup('ask r to open', true), [
    ...inputs,
    ...operationStubs,
    effects('begin'),
    effects('commit', 'failed'),
    effects('rollback'),
    `> pump clock=${clock}`,
  ]);
  expect(lines).toContain('effect s/r1.s1 grant=r phase=begin status=ok');
  expect(lines).toContain('effect s/r1.s1 grant=r phase=commit status=failed');
  expect(lines).toContain(
    'effect-failure s/r1 grant=r segment=s/r1.s1 phase=commit status=failed',
  );
  expect(lines.find(l => l.startsWith('run '))).toContain(
    'outcome=effect-failed',
  );
  expect(
    parseRecord(lines.find(l => l.startsWith('run '))!).fields.get('effect'),
  ).toBe('{grant: "r", segment: "s/r1.s1", phase: "commit", status: "failed"}');
});

test('hidden Save refuses live scopes, resumes the original Group and normalizes later save ids', () => {
  const source = setup(
    'ask r to open\nrepeat 30 times\nput 1 into x\nend repeat',
  );
  const lines = [
    ...inputs,
    ...operationStubs,
    `> pump clock=${clock} fuel-slice=20`,
    `> pump clock=${clock}`,
    '> save s1',
    '> restore from=s1 mismatch=reject',
    '> vars',
  ];
  const normal = replay('', source, lines);
  expect(normal).toContain('scope s/r1.c1 grant=r name=file action=opened');
  expect(replay('', source, lines, { restoreBetweenPumps: true })).toEqual(
    normal,
  );
});

test('recorded calls and acknowledgements replay a Host-successful malformed acquisition', () => {
  const trace = [
    ...inputs,
    `> pump clock=${clock}`,
    'call s/r1.c1 op=r.open args=[] error={}',
    'scope s/r1.c1 grant=r name=file action=opened',
    'call s/r1.c2 op=r.close args=[] result=nothing automatic=yes',
    'scope s/r1.c2 grant=r name=file action=abandoned',
  ];
  const lines = replay('', setup('ask r to open'), trace);
  expect(lines).toContain(trace[3]!);
  expect(lines).toContain(trace[4]!);
  expect(lines).toContain(trace[5]!);
  expect(lines.find(l => l.startsWith('run '))).toContain('outcome=errored');
});

test('a recorded Trace supplies lifecycle results without a live Host or Stub inputs', () => {
  const lines = replay('', setup('ask r to open', true), [
    ...inputs,
    ...operationStubs,
    effects('begin'),
    effects('commit'),
    `> pump clock=${clock}`,
  ]);
  const recorded = lines.filter(l => !l.startsWith('> stub'));
  expect(replay('', setup('ask r to open', true), recorded)).toEqual(recorded);
});

test('missing lifecycle Stubs make a case malformed rather than silently claiming conformance', () => {
  expect(() =>
    replay('', setup('ask r to open', true), [
      ...inputs,
      ...operationStubs,
      `> pump clock=${clock}`,
    ]),
  ).toThrow('No lifecycle Stub');
});

test('visible save ids follow restored counters after repeated restores with injected refusals', () => {
  const source = setup(
    'ask r to open\nrepeat 30 times\nput 1 into x\nend repeat',
  );
  const lines = [
    ...inputs,
    ...operationStubs,
    `> pump clock=${clock} fuel-slice=20`,
    `> pump clock=${clock}`,
    '> save s1',
    '> save s2',
    '> restore from=s1 mismatch=reject',
    '> save s2',
    '> restore from=s2 mismatch=reject',
    '> vars',
  ];
  expect(replay('', source, lines, { restoreBetweenPumps: true })).toEqual(
    replay('', source, lines),
  );
});

test('recorded Stop queued by successful commit is replayed after finalization in the same Pump', async () => {
  const { defineCapability, newGroup, nothing, shape, parseInstant } =
    await import('../src/index');
  const trace: string[] = [];
  const group = newGroup({ name: 'case', trace: line => trace.push(line) });
  const op = {
    mode: 'immediate' as const,
    args: [],
    result: shape.nothing,
    cost: { fuel: 0 },
    segmentBound: true,
    do: () => nothing,
  };
  const cap = defineCapability(
    'resource',
    {
      open: { ...op, scope: { opens: 'file', abandon: 'close' } },
      close: { ...op, scope: { closes: 'file' } },
    },
    {
      begin: () => ({ status: 'ok' }),
      rollback: () => ({ status: 'ok' }),
      commit: context => {
        context.group.script(context.scriptName)!.stop('committed');
        return { status: 'ok' };
      },
    },
  );
  const script = group.load({
    name: 's',
    source: 'on go\nask r to open\nend go',
    grants: { r: cap.grant('all', undefined) },
  });
  script.deliver({ name: 'go' });
  group.pump(parseInstant(clock));
  expect(replay('', setup('ask r to open', true), trace)).toEqual(trace);
});
