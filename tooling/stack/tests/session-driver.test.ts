import { expect, test } from 'bun:test';
import { parseInstant } from '@odgn/northtalk';
import { SessionHost } from '@odgn/northtalk/session';
import {
  SessionDriver,
  type DriverEvent,
  type SessionDriverOptions,
} from '../src/session-driver';

const start = parseInstant('2026-09-30T10:00:00Z');

// A Session Host and its driver over a fake Clock and fake timers.
const driven = (options: Partial<SessionDriverOptions> = {}) => {
  let ms = 0;
  const now = () => start + BigInt(ms) * 1_000_000n;
  const timers: { at: number; fire: () => void }[] = [];
  const host = new SessionHost({ now });
  const events: DriverEvent[] = [];
  const driver = new SessionDriver(host, {
    now,
    emit: event => events.push(event),
    timer: (delay, fire) => {
      const timer = { at: ms + delay, fire };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    help: ['Intro.'],
    ...options,
  });
  // Moves the fake Clock on, firing each timer as it falls due.
  const advance = (by: number) => {
    const until = ms + by;
    for (;;) {
      const due = timers
        .filter(t => t.at <= until)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) {
        break;
      }
      timers.splice(timers.indexOf(due), 1);
      ms = Math.max(ms, due.at);
      due.fire();
    }
    ms = until;
  };
  // The events since the last call.
  const take = () => events.splice(0);
  const lines = () =>
    take().flatMap(e =>
      e.k === 'output' ? e.lines : e.k === 'note' ? [e.text] : [],
    );
  return { host, driver, timers, advance, take, lines };
};

test('queues lines while the session sleeps, and runs them when it wakes', () => {
  const { driver, timers, advance, take, lines } = driven();
  driver.input('on nap\n wait 2 s\n say "done"\nend nap');
  take();
  driver.input('nap and wait');
  expect(take()).toEqual([{ k: 'prompt', prompt: 'sleeping' }]);
  expect(timers.map(t => t.at)).toEqual([2000]);
  driver.input('say "next"');
  driver.input('say "last"');
  expect(take()).toEqual([]);
  expect(driver.prompt).toBe('sleeping');
  advance(1999);
  expect(take()).toEqual([]);
  advance(1);
  expect(lines()).toEqual(['done', 'next', 'last']);
  expect(driver.prompt).toBe('entry');
});

test('wakes at a background deadline, but not on a virtual Clock', () => {
  const { driver, timers, advance, lines } = driven();
  driver.input('on later\n wait 1 s\n say "later"\nend later');
  driver.input('send later to session');
  expect(driver.prompt).toBe('entry');
  expect(timers.map(t => t.at)).toEqual([1000]);
  lines();
  advance(1000);
  expect(lines()).toEqual(['[session/r2] later']);
  expect(timers).toEqual([]);

  const virtual = driven();
  virtual.driver.input(':clock virtual 2026-09-30T10:00:00Z');
  virtual.driver.input('on later\n wait 1 s\n say "later"\nend later');
  virtual.driver.input('later and wait');
  // A virtual Clock's deadlines wait for `:clock advance`, not a timer.
  expect(virtual.driver.prompt).toBe('entry');
  expect(virtual.host.nextDeadline).toBeDefined();
  expect(virtual.timers).toEqual([]);
  virtual.lines();
  virtual.driver.input(':clock advance 1 s');
  expect(virtual.lines()).toEqual(['[session/r1] later']);
});

test('refuses lines while a debugger holds the session paused', () => {
  const { host, driver, take } = driven();
  driver.input('on boom\n put 1 / 0 into x\nend boom');
  host.debugController()!.pauseOn({ error: true });
  take();
  driver.input('boom');
  expect(take()).toEqual([{ k: 'prompt', prompt: 'paused' }]);
  driver.input('say "hi"');
  expect(take()).toEqual([
    {
      k: 'note',
      level: 'warning',
      text: 'The session is paused: continue the debugger first.',
    },
    { k: 'prompt', prompt: 'paused' },
  ]);
  host.debugController()!.pauseOn({ error: false });
  host.continueDebug('resume');
  driver.settle();
  expect(driver.prompt).toBe('entry');
});

test('collects a multiline Entry, including a Session Command', () => {
  const { driver, take, lines } = driven();
  driver.input('function f n');
  expect(take()).toEqual([{ k: 'prompt', prompt: 'continue' }]);
  driver.input(' return n * 2');
  driver.input('end f');
  expect(take().at(-1)).toEqual({ k: 'prompt', prompt: 'entry' });
  driver.input('f(');
  driver.input('21)');
  expect(lines()).toEqual(['42']);
  driver.input(':fuel f(');
  expect(driver.prompt).toBe('continue');
  driver.input('1)');
  expect(lines()).toEqual(['2', expect.stringMatching(/^fuel \{/u)]);
});

test(':help prints the Session Commands, and :quit ends the session', () => {
  const { driver, take, lines } = driven();
  driver.input(':help');
  const help = lines();
  expect(help.slice(0, 2)).toEqual(['Intro.', '']);
  expect(help).toContain('  :quit');
  driver.input(':help quit');
  expect(lines()).toEqual([':quit', '  Ends the session']);
  driver.input(':quit');
  expect(take()).toEqual([{ k: 'prompt', prompt: 'closed' }]);
  driver.input('1');
  expect(take()).toEqual([]);

  const playground = driven({ noQuit: 'Close the page.' });
  playground.driver.input(':help');
  expect(playground.lines()).not.toContain('  :quit');
  playground.driver.input(':quit');
  expect(playground.lines()).toEqual(['Close the page.']);
  expect(playground.driver.prompt).toBe('entry');
});

test('an interrupt cancels a sleeping Run, or drops an unfinished Entry', () => {
  const { driver, timers, take, lines } = driven();
  expect(driver.interrupt()).toBe(false);
  driver.input('function f n');
  take();
  expect(driver.interrupt()).toBe(true);
  expect(take()).toEqual([
    { k: 'note', level: 'info', text: '(Entry dropped)' },
    { k: 'prompt', prompt: 'entry' },
  ]);
  driver.input('on nap\n wait 2 s\n say "done"\nend nap');
  driver.input('nap and wait');
  driver.input('say "queued"');
  lines();
  expect(driver.interrupt()).toBe(true);
  expect(timers).toEqual([]);
  expect(lines()).toEqual(['! cancelled', 'queued']);
  expect(driver.prompt).toBe('entry');
});

test('end() enters an unfinished Entry once the session wakes, and closes', () => {
  const { driver, advance, take, lines } = driven();
  driver.input('on nap\n wait 1 s\n say "done"\nend nap');
  driver.input('nap and wait');
  driver.input('say');
  driver.input('"queued" &');
  take();
  driver.end();
  expect(driver.prompt).toBe('sleeping');
  advance(1000);
  const events = take();
  expect(events.at(-1)).toEqual({ k: 'prompt', prompt: 'closed' });
  expect(events.flatMap(e => (e.k === 'output' ? e.lines : []))).toEqual([
    'done',
    '! wrong argument count at 1:1',
    '! unexpected token at 1:11',
  ]);
  expect(lines()).toEqual([]);
});
