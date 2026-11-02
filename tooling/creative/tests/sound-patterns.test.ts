// Sound Patterns: `play`, `loop` and `stop` (ADR 0159, #1896), on the
// harness's virtual clock. At 120 bpm in 4/4 a bar is 2 s, and the
// Transport starting at the first Pump puts bar 0 at 0.1 s.
import { withMusicSounds } from './music-sounds';
import { expect, test } from 'bun:test';
import { createElement, createProject, type Project } from '../src/model';
import { PlaySession } from '../src/play';
import { createInstrument } from '../src/instruments/registry';
import type { InstrumentMessage } from '../src/instruments/session';
import { DEFAULT_SAMPLER } from '../src/sounds';
import { SYNTH_KIND } from './helpers/instruments';

const ms = (n: number) => BigInt(n) * 1000n;

/** A Project whose buttons, named in order, each run one click Handler. */
const project = (...clicks: string[]) => {
  const p = withMusicSounds(createProject('Groove'));
  p.instruments.push(
    createInstrument(SYNTH_KIND, 'bass'),
    createInstrument('sampler', 'drums'),
  );
  clicks.forEach((body, i) => {
    const button = createElement('button', `b${i}`);
    button.script = `on click\n${body}\nend click`;
    p.pages[0]!.elements.push(button);
  });
  return p;
};

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
  /** Pumps at every deadline up to `until`, as the Play worker does. */
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
  const click = (index: number) =>
    play.send(play.page.elements[index]!, 'click');
  /** Each step sent, as `seconds instrument sound-or-note`. */
  const steps = () =>
    sent.flatMap(m =>
      m.commands.flatMap(c =>
        c.kind === 'note'
          ? [`${m.at} ${m.instrument} ${c.sound ?? c.note}`]
          : [],
      ),
    );
  return { click, play, pumpAt, runTo, sent, steps };
};

test('loop starts on the next bar and repeats each bar on the default sampler', () => {
  const { click, play, pumpAt, runTo, steps } = session(
    project('  loop "bd hh"'),
  );
  pumpAt(0n);
  click(0);
  pumpAt(ms(700));
  expect(play.problems).toEqual([]);
  // Bar 0 has begun, so the loop waits for bar 1 at 2.1 s.
  expect(steps()).toEqual([]);
  runTo(ms(5000), ms(700));
  expect(steps()).toEqual([
    `2.1 ${DEFAULT_SAMPLER} bd`,
    `3.1 ${DEFAULT_SAMPLER} hh`,
    `4.1 ${DEFAULT_SAMPLER} bd`,
    `5.1 ${DEFAULT_SAMPLER} hh`,
  ]);
});

test('each step is sent one lead ahead, and the Pump wakes for it', () => {
  const { click, pumpAt, steps } = session(project('  loop "bd hh"'));
  pumpAt(0n);
  click(0);
  expect(pumpAt(ms(700)).nextDeadline).toBe(ms(2000));
  expect(pumpAt(ms(1999)).nextDeadline).toBe(ms(2000));
  expect(steps()).toEqual([]);
  expect(pumpAt(ms(2000)).nextDeadline).toBe(ms(3000));
  expect(steps()).toEqual([`2.1 ${DEFAULT_SAMPLER} bd`]);
});

test('a second loop on the same Instrument replaces the first on the next bar', () => {
  const p = project();
  const button = createElement('button', 'b0');
  button.script =
    'script variable n = 0\non click\n  add 1 to n\n  if n = 1 then\n    loop "bd hh"\n  else\n    loop "sd"\n  end if\nend click';
  p.pages[0]!.elements.push(button);
  const { click, pumpAt, runTo, steps } = session(p);
  pumpAt(0n);
  click(0);
  runTo(ms(2500), ms(700));
  // Halfway through bar 1, which keeps playing `bd hh` to its end.
  click(0);
  runTo(ms(6200), ms(2500));
  expect(steps()).toEqual([
    `2.1 ${DEFAULT_SAMPLER} bd`,
    `3.1 ${DEFAULT_SAMPLER} hh`,
    `4.1 ${DEFAULT_SAMPLER} sd`,
    `6.1 ${DEFAULT_SAMPLER} sd`,
  ]);
});

test('loops on different Instruments play together', () => {
  const { click, pumpAt, runTo, steps } = session(
    project('  loop "bd"\n  loop "c3 e3" on bass with {gain: 0.5}'),
  );
  pumpAt(0n);
  click(0);
  runTo(ms(3200), ms(700));
  expect(steps()).toEqual([
    `2.1 ${DEFAULT_SAMPLER} bd`,
    '2.1 bass 48',
    '3.1 bass 52',
  ]);
});

test('a note on a synth gets its gain and is released at the step’s end', () => {
  const { click, pumpAt, runTo, sent } = session(
    project('  loop "c3" on bass with {gain: 0.5}'),
  );
  pumpAt(0n);
  click(0);
  runTo(ms(2100), ms(700));
  expect(sent).toEqual([
    {
      instrument: 'bass',
      at: 2.1,
      commands: [{ kind: 'note', note: 48, velocity: 0.5 }],
    },
    {
      instrument: 'bass',
      at: 4.098,
      commands: [{ kind: 'release', note: 48 }],
    },
  ]);
});

test('a sampler step carries the pattern’s pan and speed', () => {
  const { click, pumpAt, runTo, sent } = session(
    project('  loop "bd" on drums with {pan: -1, speed: 2}'),
  );
  pumpAt(0n);
  click(0);
  runTo(ms(2100), ms(700));
  expect(sent).toEqual([
    {
      instrument: 'drums',
      at: 2.1,
      commands: [
        { kind: 'note', note: 60, sound: 'bd', velocity: 1, pan: -1, speed: 2 },
      ],
    },
  ]);
});

test('play spreads one cycle over one bar from now, and does not repeat', () => {
  const { click, pumpAt, runTo, steps } = session(
    project('  play "bd hh sd hh"'),
  );
  pumpAt(0n);
  click(0);
  runTo(ms(6000), ms(700));
  expect(steps()).toEqual([
    `0.7 ${DEFAULT_SAMPLER} bd`,
    `1.2 ${DEFAULT_SAMPLER} hh`,
    `1.7 ${DEFAULT_SAMPLER} sd`,
    `2.2 ${DEFAULT_SAMPLER} hh`,
  ]);
});

test('a play from a beat Handler starts on the beat’s musical time', () => {
  const p = project();
  p.pages[0]!.script =
    'on beat bar, beat, count\n  if count = 1 then\n    play "bd"\n  end if\nend beat';
  const { runTo, steps } = session(p);
  runTo(ms(700));
  expect(steps()).toEqual([`0.6 ${DEFAULT_SAMPLER} bd`]);
});

test('Sound Patterns belong to the Script that started them', () => {
  const { click, pumpAt, runTo, steps } = session(
    project('  loop "bd"', '  loop "sd"', '  stop'),
  );
  pumpAt(0n);
  click(0);
  click(1);
  runTo(ms(2200), ms(700));
  expect(steps()).toEqual([
    `2.1 ${DEFAULT_SAMPLER} bd`,
    `2.1 ${DEFAULT_SAMPLER} sd`,
  ]);
  // The third button's `stop` ends only its own, which it has none of.
  click(2);
  runTo(ms(4200), ms(2200));
  expect(steps().length).toBe(4);
});

test('stop ends a Script’s patterns, all of them or on one Instrument', () => {
  const { click, pumpAt, runTo, steps } = session(
    project(
      '  loop "bd"\n  loop "c3" on bass',
      '  loop "bd"\n  loop "c3" on bass\n  stop bass',
      '  loop "bd"\n  loop "c3" on bass\n  stop',
    ),
  );
  pumpAt(0n);
  click(1);
  click(2);
  runTo(ms(4200), ms(700));
  expect(steps()).toEqual([
    `2.1 ${DEFAULT_SAMPLER} bd`,
    `4.1 ${DEFAULT_SAMPLER} bd`,
  ]);
});

test('stopping a Script, leaving its Page and ending Play stop its patterns', () => {
  const p = project('  loop "bd"');
  p.pages.push({ ...createProject('Other').pages[0]!, name: 'other' });
  const { click, play, pumpAt, runTo, steps } = session(p);
  pumpAt(0n);
  click(0);
  runTo(ms(2200), ms(700));
  expect(steps().length).toBe(1);
  // The Core releases the Script's Grants when it stops.
  play.group
    .script(play.group.scriptNames().find(n => n.includes('b0'))!)!
    .stop('test');
  runTo(ms(6200), ms(2200));
  expect(steps().length).toBe(1);
  expect(play.patterns.active).toBe(false);

  const again = session(p);
  again.pumpAt(0n);
  again.click(0);
  again.runTo(ms(2200), ms(700));
  again.play.goTo(1);
  again.runTo(ms(6200), ms(2200));
  expect(again.steps().length).toBe(1);

  const ended = session(p);
  ended.pumpAt(0n);
  ended.click(0);
  ended.runTo(ms(2200), ms(700));
  ended.play.stop(ms(2200));
  expect(ended.play.patterns.active).toBe(false);
  expect(ended.pumpAt(ms(4200)).nextDeadline).toBeUndefined();
});

test('a pattern built at run time is checked when it plays', () => {
  const { click, play, pumpAt, runTo } = session(
    project(
      '  put "bd [hh" into p\n  loop p',
      '  loop "zz" & ""',
      '  loop "bd" on "nobody"',
      '  loop "bd" with {gain: 2}',
      '  loop "bd" with {repeat: true}',
      '  put "bd" into p\n  play p on bass',
    ),
  );
  pumpAt(0n);
  for (let i = 0; i < 6; i++) {
    click(i);
  }
  runTo(ms(4000));
  expect(play.problems.map(p => p.message)).toEqual([
    ...Array(5).fill('"sound" failed while doing "loop"'),
    '"sound" failed while doing "play"',
  ]);
  expect(play.patterns.active).toBe(false);
});

test('`tell sound to` spells the same Operations', () => {
  const { click, pumpAt, runTo, steps } = session(
    project('  tell sound to loop "bd" on drums'),
  );
  pumpAt(0n);
  click(0);
  runTo(ms(2200), ms(700));
  expect(steps()).toEqual(['2.1 drums bd']);
});

test('name:n plays the Project sound of that name, never wrapping (ADR 0161)', () => {
  const p = project('  loop "bd:1 bd:0"');
  for (const name of ['bd', 'bd:1']) {
    p.assets.push({
      name,
      fileName: `${name}.wav`,
      hash: name.padEnd(64, '0'),
      mediaType: 'audio/wav',
      size: 3,
    });
  }
  const { click, play, pumpAt, runTo, steps } = session(p);
  pumpAt(0n);
  click(0);
  runTo(ms(1500));
  expect(play.problems).toEqual([]);
  expect(steps()).toEqual([
    `0.1 ${DEFAULT_SAMPLER} bd:1`,
    `1.1 ${DEFAULT_SAMPLER} bd`,
  ]);
});
