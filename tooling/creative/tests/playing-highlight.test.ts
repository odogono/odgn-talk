// The Playing Highlight (#2176): where a Pattern Event's characters are in
// a Script, and the worker hearing each Pattern Event as it is sent.
import { withMusicSounds } from './music-sounds';
import { expect, test } from 'bun:test';
import { createElement, createProject } from '../src/model';
import { PlaySession } from '../src/play';
import { patternRanges } from '../src/playing-highlight';
import type { HeardEvent } from '../src/sound-patterns';

const ms = (n: number) => BigInt(n) * 1000n;

test('an event lights its characters in every literal with its exact text', () => {
  const source =
    'on click\n  loop "bd [hh hh]"\n  play "bd [hh hh]"\nend click';
  const hh = 'bd [hh hh]'.indexOf('hh');
  const ranges = patternRanges(source, 'bd [hh hh]', hh, hh + 2);
  expect(ranges.map(r => source.slice(r.from, r.to))).toEqual(['hh', 'hh']);
  expect(ranges[0]!.from).toBe(source.indexOf('hh'));
  // An edited pattern no longer matches what is playing.
  expect(patternRanges(source, 'bd hh', 0, 2)).toEqual([]);
});

test('backtick and raw text light where the characters are written', () => {
  const tick = 'on click\n  loop `bd sd`\nend click';
  const [lit] = patternRanges(tick, 'bd sd', 3, 5);
  expect(tick.slice(lit!.from, lit!.to)).toBe('sd');
  const raw = 'on click\n  loop """bd sd"""\nend click';
  const [rawLit] = patternRanges(raw, 'bd sd', 3, 5);
  expect(raw.slice(rawLit!.from, rawLit!.to)).toBe('sd');
});

test('the session hears each Pattern Event it sends, with its owner and text', () => {
  const p = withMusicSounds(createProject('Groove'));
  const button = createElement('button', 'b0');
  button.script = 'on click\n  loop "bd hh"\n  play "sd"\nend click';
  p.pages[0]!.elements.push(button);
  const heard: HeardEvent[] = [];
  const play = new PlaySession(p, 0, {
    instrumentBackend: () => {},
    heard: event => heard.push(event),
  });
  const pumpAt = (us: bigint) => {
    let result = play.pump(us);
    while (result.state === 'sliced') {
      result = play.pump(us);
    }
    return result;
  };
  pumpAt(0n);
  play.send(play.page.elements[0]!, 'click');
  for (const t of [700, 2000, 3000]) {
    pumpAt(ms(t));
  }
  expect(play.problems).toEqual([]);
  const owner = heard[0]!.owner;
  expect(owner).toContain('b0');
  expect(
    heard.map(e => `${e.text}:${e.text.slice(e.from, e.to)}:${e.time}`),
  ).toEqual(
    expect.arrayContaining([
      `sd:sd:${heard.find(e => e.text === 'sd')!.time}`,
      `bd hh:bd:${ms(2100)}`,
      `bd hh:hh:${ms(3100)}`,
    ]),
  );
  expect(heard.every(e => e.owner === owner && e.end > e.time)).toBe(true);
});

test('each heard Pattern Event carries the pattern cycle it falls in (#2181)', () => {
  const p = withMusicSounds(createProject('Alternating'));
  const button = createElement('button', 'b0');
  button.script = 'on click\n  loop "<bd hh>"\nend click';
  p.pages[0]!.elements.push(button);
  const heard: HeardEvent[] = [];
  const play = new PlaySession(p, 0, {
    instrumentBackend: () => {},
    heard: event => heard.push(event),
  });
  const pumpAt = (us: bigint) => {
    let result = play.pump(us);
    while (result.state === 'sliced') {
      result = play.pump(us);
    }
  };
  pumpAt(0n);
  play.send(play.page.elements[0]!, 'click');
  for (let t = 500; t <= 10_000; t += 500) {
    pumpAt(ms(t));
  }
  expect(heard.length).toBeGreaterThan(2);
  expect(heard.map(e => e.cycle)).toEqual(heard.map((_, i) => i));
  expect(
    heard.every(
      e => e.text.slice(e.from, e.to) === (e.cycle % 2 ? 'hh' : 'bd'),
    ),
  ).toBe(true);
});
