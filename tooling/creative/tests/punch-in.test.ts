// Punch In (ADR 0157, #1897) on the harness's virtual clock. At 120 bpm in
// 4/4 a bar is 2 s, and the Transport starting at the first Pump puts bar 1
// at 0.1 s, so bar n+1 begins at 0.1 + 2n s and its Punch In applies a lead
// earlier, at 2n s.
import { withMusicSounds } from './music-sounds';
import { expect, test } from 'bun:test';
import {
  createElement,
  createPage,
  createProject,
  type Project,
} from '../src/model';
import type { Envelope } from '@northtalk/tooling/worker-supervisor';
import { PlaySession } from '../src/play';
import { PlayHost } from '../src/play-host';
import type { PlayRequest, PlayResponse } from '../src/play-protocol';
import { scriptOwners } from '../src/script-manifest';
import { createInstrument } from '../src/instruments/registry';
import type { InstrumentMessage } from '../src/instruments/session';
import { DEFAULT_SAMPLER } from '../src/sounds';

const ms = (n: number) => BigInt(n) * 1000n;
const kit = DEFAULT_SAMPLER;

const session = (p: Project) => {
  const sent: InstrumentMessage[] = [];
  const play = new PlaySession(p, 0, {
    instrumentBackend: message => sent.push(message),
  });
  const pumpAt = (us: bigint) => {
    let result = play.pump(us);
    while (result.state === 'sliced') {
      result = play.pump(us);
    }
    return result;
  };
  /** Pumps at every deadline from `from` up to `until`, as the worker does. */
  const runTo = (until: bigint, from = 0n) => {
    let now = from;
    for (let i = 0; i < 1000; i++) {
      const next = pumpAt(now).nextDeadline;
      if (next === undefined || next > until) {
        return;
      }
      now = next > now ? next : now + 1n;
    }
    throw new Error('too many Pumps');
  };
  /** Each step sent, as `seconds instrument sound-or-note`. */
  const steps = () =>
    sent.flatMap(m =>
      m.commands.flatMap(c =>
        c.kind === 'note'
          ? [`${m.at} ${m.instrument} ${c.sound ?? c.note}`]
          : [],
      ),
    );
  const label = (name: string) => {
    const element = play.page.elements.find(e => e.name === name);
    return element && 'label' in element ? element.label : undefined;
  };
  return { label, play, pumpAt, runTo, steps };
};

// A Page whose Script loops `pattern` from `openScript`, counting the times
// it opened in a Script Variable shown on the `count` button.
const groove = (pattern: string) =>
  `script variable opened = 0
on openScript
  add 1 to opened
  set the label of count to "" & opened
  loop "${pattern}"
end openScript`;

const project = (pageScript: string) => {
  const p = withMusicSounds(createProject('Live'));
  p.instruments.push(createInstrument('sampler', 'drums'));
  p.pages[0]!.script = pageScript;
  p.pages[0]!.elements.push(createElement('button', 'count'));
  return p;
};

test('openScript reaches a Script when it loads, so its loop starts with Play', () => {
  const { label, runTo, steps } = session(project(groove('bd')));
  runTo(ms(2500));
  expect(label('count')).toBe('1');
  expect(steps()).toEqual([`0.1 ${kit} bd`, `2.1 ${kit} bd`]);
});

test('a Script that keeps musical time is Punched In at the next bar', () => {
  const p = project(groove('bd'));
  const { label, play, runTo, steps } = session(p);
  runTo(ms(1500));
  expect(
    play.punchIn(
      { kind: 'script', owner: p.pages[0]! },
      groove('sd'),
      ms(1500),
    ),
  ).toEqual({ kind: 'bar', bar: 2 });
  runTo(ms(1999), ms(1500));
  // Bar 1 plays out on the old code.
  expect(label('count')).toBe('1');
  runTo(ms(4500), ms(1999));
  // The old pattern is released and the new one starts on bar 2; the
  // Script Variable carried across the Reload.
  expect(steps()).toEqual([`0.1 ${kit} bd`, `2.1 ${kit} sd`, `4.1 ${kit} sd`]);
  expect(label('count')).toBe('2');
  expect(play.problems).toEqual([]);
});

test('a beat Handler gets the new bar’s first beat in the new code', () => {
  const p = project(
    'on beat bar, beat, n\n  set the label of count to "old " & bar & "." & beat\nend beat',
  );
  const { label, play, runTo } = session(p);
  runTo(ms(1200));
  expect(
    play.punchIn(
      { kind: 'script', owner: p.pages[0]! },
      'on beat bar, beat, n\n  set the label of count to "new " & bar & "." & beat\nend beat',
      ms(1200),
    ),
  ).toEqual({ kind: 'bar', bar: 2 });
  runTo(ms(1600), ms(1200));
  expect(label('count')).toBe('old 1.4');
  runTo(ms(2000), ms(1600));
  expect(label('count')).toBe('new 2.1');
});

test('a Script without musical time is Punched In at once, keeping its mailbox', () => {
  const p = project('');
  const button = createElement('button', 'go');
  button.script =
    'script variable n = 0\non poke\n  add 1 to n\n  set the label of me to "old " & n\nend poke';
  p.pages[0]!.elements.push(button);
  const { label, play, pumpAt } = session(p);
  pumpAt(0n);
  play.send(play.page.elements[1]!, 'poke' as never);
  pumpAt(ms(10));
  expect(label('go')).toBe('old 1');
  // A message waiting when the Punch In applies goes to the new code.
  play.send(play.page.elements[1]!, 'poke' as never);
  expect(
    play.punchIn(
      { kind: 'script', owner: button },
      'script variable n = 0\non poke\n  add 1 to n\n  set the label of me to "new " & n\nend poke',
      ms(10),
    ),
  ).toEqual({ kind: 'now' });
  pumpAt(ms(10));
  expect(label('go')).toBe('new 2');
});

test('a failed load keeps the old code playing and reports in Errors', () => {
  const p = project(groove('bd'));
  const { label, play, runTo, steps } = session(p);
  runTo(ms(1500));
  play.punchIn(
    { kind: 'script', owner: p.pages[0]! },
    'on openScript\n  loop "sd"\nend nonsense',
    ms(1500),
  );
  runTo(ms(4500), ms(1500));
  expect(steps()).toEqual([`0.1 ${kit} bd`, `2.1 ${kit} bd`, `4.1 ${kit} bd`]);
  expect(label('count')).toBe('1');
  expect(play.problems.length).toBeGreaterThan(0);
  expect(play.problems[0]!.owner).toBe(p.pages[0]!);
});

const withLibrary = (beat: string) => {
  const p = project(
    'use hit from rhythm\non openScript\n  hit\nend openScript',
  );
  p.libraries.push({
    id: 1,
    name: 'rhythm',
    source: `on hit\n  loop "${beat}"\nend hit`,
  });
  const button = createElement('button', 'other');
  button.script = 'use hit from rhythm\non openScript\n  hit\nend openScript';
  p.pages[0]!.elements.push(button);
  return p;
};

test('a Library is Punched In with every Script that imports it, on one bar', () => {
  const p = withLibrary('bd');
  const { play, runTo, steps } = session(p);
  runTo(ms(1500));
  expect(
    play.punchIn(
      { kind: 'library', name: 'rhythm' },
      'on hit\n  loop "sd"\nend hit',
      ms(1500),
    ),
  ).toEqual({ kind: 'bar', bar: 2 });
  runTo(ms(2500), ms(1500));
  expect(steps()).toEqual([
    `0.1 ${kit} bd`,
    `0.1 ${kit} bd`,
    `2.1 ${kit} sd`,
    `2.1 ${kit} sd`,
  ]);
  expect(play.problems).toEqual([]);
});

test('a Library Punch In keeps each importer’s mailbox for the new code', () => {
  const p = project('');
  p.libraries.push({
    id: 1,
    name: 'fmt',
    source: 'function tag n\n  return "old " & n\nend tag',
  });
  const button = createElement('button', 'go');
  button.script =
    'use tag from fmt\non hold\n  repeat 100000 times\n    put 1 into x\n  end repeat\nend hold\non poke\n  set the label of me to tag(1)\nend poke';
  p.pages[0]!.elements.push(button);
  const { label, play, pumpAt } = session(p);
  pumpAt(0n);
  // The Fuel Slice preempts `hold`, so `poke` is still in the mailbox when
  // the Punch In applies.
  play.send(play.page.elements[1]!, 'hold' as never);
  play.send(play.page.elements[1]!, 'poke' as never);
  expect(play.pump(ms(10)).state).toBe('sliced');
  expect(label('go')).toBe('Button');
  expect(
    play.punchIn(
      { kind: 'library', name: 'fmt' },
      'function tag n\n  return "new " & n\nend tag',
      ms(20),
    ),
  ).toEqual({ kind: 'now' });
  pumpAt(ms(20));
  expect(label('go')).toBe('new 1');
  expect(play.problems).toEqual([]);
});

test('a Library Punch In that an importer can’t load changes none of them', () => {
  const p = withLibrary('bd');
  const { play, runTo, steps } = session(p);
  runTo(ms(1500));
  // Both importers use `hit`, which the new Library no longer has.
  play.punchIn(
    { kind: 'library', name: 'rhythm' },
    'on strike\n  loop "sd"\nend strike',
    ms(1500),
  );
  runTo(ms(2500), ms(1500));
  expect(steps().slice(-2)).toEqual([`2.1 ${kit} bd`, `2.1 ${kit} bd`]);
  expect(play.problems.length).toBeGreaterThan(0);
  expect(play.libraryOf('rhythm')!.source).toContain('loop "bd"');
});

test('a Script that isn’t loaded is not Punched In', () => {
  const p = project(groove('bd'));
  const away = createPage('Away');
  away.script = groove('sd');
  p.pages.push(away);
  const { play, runTo } = session(p);
  runTo(ms(100));
  expect(
    play.punchIn({ kind: 'script', owner: away }, groove('hh'), ms(100)),
  ).toEqual({ kind: 'notLoaded' });
});

test('Punch In is refused while a Run is stopped', () => {
  // An uncaught error stops its Run as a Breakpoint does.
  const p = project('on click\n  set the label of count to 1\nend click');
  const { play, pumpAt } = session(p);
  pumpAt(0n);
  play.debug.pauseOn({ uncaughtError: true });
  play.send(play.page, 'click');
  play.pump(ms(10));
  expect(play.debugPaused).toBe(true);
  expect(
    play.punchIn(
      { kind: 'script', owner: p.pages[0]! },
      'on click\nend click',
      ms(10),
    ),
  ).toEqual({ kind: 'resumeFirst' });
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
};

// A Play worker's host on a wall clock the test moves, in ms.
const hosted = (p: Project) => {
  const clock = { wall: 0 };
  const steps: string[] = [];
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = ({ data }: MessageEvent<InstrumentMessage>) => {
    for (const c of data.commands) {
      if (c.kind === 'note') {
        steps.push(`${data.at} ${c.sound ?? c.note}`);
      }
    }
  };
  const replies: PlayResponse[] = [];
  const host = new PlayHost(
    ({ response }) => replies.push(response),
    () => BigInt(Math.round(clock.wall * 1000)),
    () => clock.wall,
    undefined,
    () => clock.wall,
  );
  let id = 1;
  const request = (body: PlayRequest) =>
    host.receive({ id: id++, request: body } satisfies Envelope<PlayRequest>);
  request({
    kind: 'open',
    session: 1,
    project: p,
    pageIndex: 0,
    seed: 0n,
    instrumentPort: port2,
    audioClock: { audio: 0, epoch: 0 },
  });
  return { clock, replies, request, steps };
};

test('while Paused, a Punch In waits for the next bar after Resume', async () => {
  const p = project(groove('bd'));
  const { clock, replies, request, steps } = hosted(p);
  await until(() => steps.length === 1);
  clock.wall = 1500;
  request({ kind: 'pause', session: 1 });
  request({
    kind: 'punchIn',
    session: 1,
    place: { kind: 'script', owner: scriptOwners(p).indexOf(p.pages[0]!) },
    source: groove('sd'),
  });
  expect(replies.filter(r => r.kind === 'punchIn')).toEqual([
    {
      kind: 'punchIn',
      reply: { kind: 'bar', bar: 2 },
    },
  ]);
  // No time passes while paused, so nothing is applied or sounds.
  clock.wall = 9000;
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(steps).toEqual(['0.115 bd']);
  request({ kind: 'resume', session: 1 });
  // The audio was suspended too: it resumes where it stopped.
  request({
    kind: 'audioClock',
    session: 1,
    reading: { audio: 1.5, epoch: 9000 },
  });
  clock.wall = 9600;
  await until(() => steps.length === 2);
  // Bar 2 begins 0.6 s of Play time after Resume; the Play clock runs a
  // 15 ms margin ahead of the audio.
  expect(steps).toEqual(['0.115 bd', '2.115 sd']);
  request({ kind: 'stop', session: 1 });
});
