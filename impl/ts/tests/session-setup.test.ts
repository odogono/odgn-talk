import { expect, test } from 'bun:test';
import {
  parseInstant,
  text,
  type CalendarImpl,
  type LocaleImpl,
} from '../src/index';
import { SessionHost, type SessionEnvironment } from '../src/session';
import { createReplayHost, parseRecord, replayTrace } from '../src/replay';

const readSource = (): never => {
  throw new Error('Session sources must be inline');
};
const record = (
  commands: string[],
  builtIns?: SessionEnvironment['builtIns'],
) => {
  const trace: string[] = [];
  const host = new SessionHost({
    now: () => parseInstant('2026-10-09T10:00:00Z'),
    trace: line => trace.push(line),
    builtIns,
  });
  const outputs = commands.map(command => host.input(command));
  host.inspect();
  return { host, trace, outputs };
};

// Incremental replay takes Stubs as Host Inputs, while fixed replay can read
// outcomes directly from the recorded Trace. Both consume the same Setup.
const replayIncrementally = (host: SessionHost, trace: string[]) => {
  const replay = createReplayHost(readSource, host.setup);
  const grants = host.setup.scripts![0]!.grants!;
  for (const line of trace) {
    const r = parseRecord(line);
    if (r.name === 'call') {
      const [grant, operation] = r.fields.get('op')!.split('.');
      const capability = grants[grant!]!.capability ?? grant;
      const answer = r.fields.has('error')
        ? `error=${r.fields.get('error')}`
        : `value=${r.fields.get('result') ?? 'nothing'}`;
      replay.apply(
        `> stub ${capability}.${operation} ${answer}${r.fields.has('charged') ? ` charge=${r.fields.get('charged')}` : ''}`,
      );
    } else if (r.name === 'effect') {
      replay.apply(
        `> stub-effect session.${r.fields.get('grant')} phase=${r.fields.get('phase')} status=${r.fields.get('status')}`,
      );
    }
  }
  for (const input of trace.filter(line => line.startsWith('> '))) {
    replay.apply(input);
  }
  expect(replay.trace.filter(line => !line.startsWith('> stub'))).toEqual(
    trace,
  );
  return replay;
};

const checkReplay = (host: SessionHost, trace: string[]) => {
  for (const restoreBetweenPumps of [false, true]) {
    const driver = replayTrace(readSource, host.setup, trace, {
      restoreBetweenPumps,
    });
    let next = driver.next();
    while (!next.done) {
      next = driver.next();
    }
    expect(next.value).toEqual(trace);
  }
  return replayIncrementally(host, trace);
};

test('Store bindings and aliases survive Session Setup replay and :restore', () => {
  const { host, trace, outputs } = record([
    ':grant scores store games',
    ':grant same store games',
    ':grant other store',
    'ask scores to increment "plays", 3',
    'on peek\n  ask same to get "plays"\n  say it\n  ask other to get "plays"\n  say it\nend peek',
    ':save',
    'peek',
    'ask scores to increment "plays"',
    ':restore',
    'peek',
  ]);
  expect(outputs[6]).toEqual(['3', 'nothing']);
  expect(outputs[9]).toEqual(['4', 'nothing']);
  expect(host.setup.scripts![0]!.grants).toMatchObject({
    scores: { capability: 'store', binding: 'games' },
    same: { binding: 'games' },
    other: { binding: 'default' },
  });
  const replay = checkReplay(host, trace);
  expect(replay.group.script('session')).toBeDefined();
});

const unused = (): never => {
  throw new Error('Unused test Operation');
};
const calendar: CalendarImpl = {
  today: unused,
  now: unused,
  toCivil: unused,
  toInstant: unused,
  offset: unused,
  zone: call => text(call.binding),
};
const locale: LocaleImpl = {
  compare: unused,
  dayNames: unused,
  lower: unused,
  monthNames: unused,
  numberSymbols: unused,
  rank: unused,
  upper: unused,
  tag: call => text(call.binding),
};

test('Calendar and Locale use explicit and default bindings in both replay Hosts', () => {
  const { host, trace, outputs } = record(
    [
      ':grant cal calendar Europe/London',
      ':grant utc calendar',
      ':grant loc locale en-GB',
      ':grant neutral locale',
      'on bindings\n  ask cal to zone\n  say it\n  ask utc to zone\n  say it\n  ask loc to tag\n  say it\n  ask neutral to tag\n  say it\nend bindings',
      'bindings',
      ':save',
      ':restore',
      'bindings',
    ],
    { calendar, locale },
  );
  expect(outputs[5]).toEqual(['Europe/London', 'UTC', 'en-GB', 'und']);
  expect(outputs[8]).toEqual(outputs[5]);
  checkReplay(host, trace);
});

test('Session Setup snapshots stay immutable and the Manifest does not start the session', () => {
  const { host } = record([]);
  const initial = host.setup;
  expect(host.input(':mock db.get immediate')).toEqual([]);
  const mocked = host.setup;
  expect(host.input(':mock db.get suspending')).toEqual([]);
  expect(host.input(':grant scores store games')).toEqual([]);
  expect(initial.operations).toEqual([]);
  expect(mocked.operations![0]!.mode).toBe('immediate');
  expect(host.setup.operations![0]!.mode).toBe('suspending');
  expect(Object.isFrozen(host.setup.scripts![0]!.grants!.scores)).toBe(true);
  expect(() => {
    host.setup.scripts![0]!.grants!.scores!.binding = 'changed';
  }).toThrow();
  const manifest = JSON.parse(host.exportManifest());
  expect(manifest.grants.map((g: { name: string }) => g.name)).toEqual([
    'console',
    'db',
    'scores',
  ]);
  expect(host.started).toBe(false);
  expect(host.inspect()).toBeNull();
});

test('a Script loaded after Restore belongs to the current replay Group', () => {
  const replay = createReplayHost(readSource, {
    scripts: [
      { name: 'first', source: '(inline)', text: '' },
      {
        name: 'later',
        source: '(inline)',
        text: 'script variable answer = 42',
      },
    ],
  });
  replay.apply('> load first');
  replay.apply('> save');
  replay.apply('> restore from=s1');
  replay.apply('> load later');
  replay.apply('> vars');
  expect(replay.trace).toContain('vars later answer=42');
  expect(replay.group.script('later')).toBeDefined();
});
