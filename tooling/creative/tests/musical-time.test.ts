// `wait N bars` and `wait N beats` on Folio's Transport (ADR 0166, #2066),
// on the harness's virtual clock. At 120 bpm in 4/4 a bar is 2 s and the
// Transport starting at the first Pump puts bar n's line at 0.1 + 2(n − 1) s;
// a Wait ends, and its Run resumes, a lead (0.1 s) before its line.
import { withMusicSounds } from './music-sounds';
import { expect, test } from 'bun:test';
import { createElement, createProject, type Project } from '../src/model';
import { PlaySession } from '../src/play';
import { createInstrument } from '../src/instruments/registry';
import type { InstrumentMessage } from '../src/instruments/session';
import { SYNTH_KIND } from './helpers/instruments';

const ms = (n: number) => BigInt(n) * 1000n;

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
  /** Each note sent, as `seconds instrument sound-or-note`. */
  const steps = () =>
    sent.flatMap(m =>
      m.commands.flatMap(c =>
        c.kind === 'note'
          ? [`${m.at} ${m.instrument} ${c.sound ?? c.note}`]
          : [],
      ),
    );
  return { play, pumpAt, runTo, steps };
};

const band = (script: string) => {
  const p = withMusicSounds(createProject('Song'));
  p.instruments.push(
    createInstrument('sampler', 'drums'),
    createInstrument(SYNTH_KIND, 'bass'),
  );
  p.pages[0]!.script = script;
  p.pages[0]!.elements.push(createElement('button', 'go'));
  return p;
};

/** The steps one Instrument played, in time order. */
const on = (steps: string[], instrument: string) =>
  steps
    .filter(step => step.split(' ')[1] === instrument)
    .map(step => step.replace(` ${instrument} `, ' '))
    .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b));

// #2044's first worked example: one Handler per part, started side by side.
const parts = (drums: [string, string], bass: [string, string]) => `
on openScript
  send bassPart to me
  send drumPart to me
end openScript

on bassPart
  loop "${bass[0]}" on bass
  wait 1 bar
  loop "${bass[1]}" on bass
end bassPart

on drumPart
  loop "${drums[0]}" on drums
  wait 2 bars
  loop "${drums[1]}" on drums
  wait 1 bar
  stop drums
end drumPart
`;

test('parts started side by side play as written on Perform, in lockstep', () => {
  const { play, runTo, steps } = session(
    band(parts(['bd', 'sd'], ['c3', 'e3'])),
  );
  runTo(ms(8500));
  expect(play.problems).toEqual([]);
  expect(on(steps(), 'drums')).toEqual(['0.1 bd', '2.1 bd', '4.1 sd']);
  expect(on(steps(), 'bass')).toEqual([
    '0.1 48',
    '2.1 52',
    '4.1 52',
    '6.1 52',
    '8.1 52',
  ]);
});

// #2044's second worked example: one Handler drives every part's sections.
const conductor = `
on openScript
  intro()
  wait 2 bars
  verse()
end openScript

on intro
  loop "c3" on bass
  loop "bd" on drums
end intro

on verse
  loop "e3" on bass
  loop "sd" on drums
end verse
`;

test('a conductor switches every part on the bar its wait ends on', () => {
  const { play, runTo, steps } = session(band(conductor));
  runTo(ms(6500));
  expect(play.problems).toEqual([]);
  expect(on(steps(), 'drums')).toEqual([
    '0.1 bd',
    '2.1 bd',
    '4.1 sd',
    '6.1 sd',
  ]);
  expect(on(steps(), 'bass')).toEqual(['0.1 48', '2.1 48', '4.1 52', '6.1 52']);
});

test('a Run resumed in a late Pump still starts its loop on the bar line', () => {
  const { play, pumpAt, runTo, steps } = session(band(conductor));
  runTo(ms(3900));
  // The Wait ends at 4 s; this Pump comes 150 ms after that.
  pumpAt(ms(4150));
  runTo(ms(6500), ms(4150));
  expect(play.problems).toEqual([]);
  expect(on(steps(), 'drums')).toEqual([
    '0.1 bd',
    '2.1 bd',
    '4.1 sd',
    '6.1 sd',
  ]);
});

test('play straight after a bar wait spreads its cycle over that bar', () => {
  const p = band('');
  p.pages[0]!.elements[0]!.script =
    'on click\n  wait 1 bar\n  play "bd sd" on drums\nend click\n';
  const { play, pumpAt, runTo, steps } = session(p);
  pumpAt(0n);
  play.send(play.page.elements[0]!, 'click');
  runTo(ms(4000), ms(700));
  expect(play.problems).toEqual([]);
  expect(steps()).toEqual(['2.1 drums bd', '3.1 drums sd']);
});

test('a tempo change mid-wait stretches the bars still to come', () => {
  const { play, runTo, steps } = session(
    band(`
on openScript
  send faster to me
  loop "bd" on drums
  wait 2 bars
  loop "sd" on drums
end openScript

on faster
  wait 2 beats
  tell transport to setTempo 60
end faster
`),
  );
  runTo(ms(8000));
  expect(play.problems).toEqual([]);
  // From bar 1's last beat, at 1.6 s, a beat lasts a second.
  expect(steps()).toEqual(['0.1 drums bd', '2.6 drums bd', '6.6 drums sd']);
});

test('a time signature set mid-wait takes effect at the next bar line', () => {
  const { play, runTo, steps } = session(
    band(`
on openScript
  send threeFour to me
  loop "bd" on drums
  wait 2 bars
  loop "sd" on drums
end openScript

on threeFour
  wait 1 beat
  tell transport to setTimeSignature 3, 4
end threeFour
`),
  );
  runTo(ms(5200));
  expect(play.problems).toEqual([]);
  // Bar 2 is in 3/4, so bar 3 begins 1.5 s after it.
  expect(steps()).toEqual([
    '0.1 drums bd',
    '2.1 drums bd',
    '3.6 drums sd',
    '5.1 drums sd',
  ]);
});

test('a stopped Transport holds a wait, which counts on from bar 1 when it starts', () => {
  const p = band(`
on openScript
  send halt to me
  wait 2 bars
  tell bass to play 60
end openScript

on halt
  wait 5 beats
  tell transport to stop
end halt
`);
  p.pages[0]!.elements[0]!.script =
    'on click\n  tell transport to start\nend click\n';
  const { play, pumpAt, runTo, steps } = session(p);
  // Stopped during bar 2, one bar line, bar 3's, is still to come.
  runTo(ms(9000));
  expect(steps()).toEqual([]);
  play.send(play.page.elements[0]!, 'click');
  pumpAt(ms(10_000));
  runTo(ms(14_000), ms(10_000));
  expect(play.problems).toEqual([]);
  expect(steps()).toEqual(['12.1 bass 60']);
});

test('a Punch In ends the old waits and counts the new ones from the punched bar', () => {
  const p = band(parts(['bd', 'sd'], ['c3', 'e3']));
  const { play, pumpAt, runTo, steps } = session(p);
  runTo(ms(3000));
  expect(
    play.punchIn(
      { kind: 'script', owner: p.pages[0]! },
      parts(['cp', 'rim'], ['g3', 'a3']),
      ms(3000),
    ),
  ).toEqual({ kind: 'bar', bar: 3 });
  // The Pump that applies it comes after bar 3 began.
  runTo(ms(3999), ms(3000));
  pumpAt(ms(4150));
  runTo(ms(10_500), ms(4150));
  expect(play.problems).toEqual([]);
  // No `sd` at bar 3: the old drumPart's wait ended with its Run.
  expect(on(steps(), 'drums')).toEqual([
    '0.1 bd',
    '2.1 bd',
    '4.1 cp',
    '6.1 cp',
    '8.1 rim',
  ]);
  expect(on(steps(), 'bass')).toEqual([
    '0.1 48',
    '2.1 52',
    '4.1 55',
    '6.1 57',
    '8.1 57',
    '10.1 57',
  ]);
});

test('Hush ends every part’s waits, and Stop ends the rest', () => {
  const { play, runTo, steps } = session(band(conductor));
  runTo(ms(1000));
  expect(play.transport.waits.size).toBe(1);
  play.hush();
  runTo(ms(8000), ms(1000));
  expect(play.problems).toEqual([]);
  expect(play.transport.waits.size).toBe(0);
  expect(on(steps(), 'drums')).toEqual(['0.1 bd']);

  const again = session(band(parts(['bd', 'sd'], ['c3', 'e3'])));
  again.runTo(ms(1000));
  expect(again.play.transport.waits.size).toBe(2);
  again.play.stop(ms(1000));
  expect(again.play.transport.waits.size).toBe(0);
});

test('two Runs looping on one Instrument follow last-wins', () => {
  const { play, runTo, steps } = session(
    band(`
on openScript
  send verse to me
  send chorus to me
end openScript

on verse
  loop "bd" on drums
  wait 1 bar
  loop "hh" on drums
end verse

on chorus
  wait 2 bars
  loop "sd" on drums
end chorus
`),
  );
  runTo(ms(6500));
  expect(play.problems).toEqual([]);
  expect(steps()).toEqual([
    '0.1 drums bd',
    '2.1 drums hh',
    '4.1 drums sd',
    '6.1 drums sd',
  ]);
});

// A Script that keeps musical time and plays `note` two beats in.
const twoBeatsIn = (note: number) => `
on openScript
  loop "bd" on drums
  wait 2 beats
  tell bass to play ${note}
end openScript
`;

test('a Punch In applied in a very late Pump still counts from the punched bar', () => {
  const p = band(twoBeatsIn(60));
  const { play, pumpAt, runTo, steps } = session(p);
  runTo(ms(3000));
  play.punchIn(
    { kind: 'script', owner: p.pages[0]! },
    twoBeatsIn(62),
    ms(3000),
  );
  runTo(ms(3999), ms(3000));
  // Applied 600 ms after it was due: bar 3 is at 4.1 s, its third beat at 5.1 s.
  pumpAt(ms(4600));
  runTo(ms(6000), ms(4600));
  expect(play.problems).toEqual([]);
  expect(on(steps(), 'bass')).toEqual(['1.1 60', '5.1 62']);
});
