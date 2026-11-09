import { expect, test } from 'bun:test';
import { createElement, createProject } from '../src/model';
import {
  needsInstrumentAudio,
  patternDiagnostics,
  patternProblems,
  patternTexts,
  projectPatternNames,
  soundDecodeOrder,
} from '../src/pattern-checks';
import { PlaySession } from '../src/play';

const names = { sounds: new Set(['bd', 'hh', 'sd', 'sd:2', 'Door Creak']) };

test('pattern texts are literals given to play or loop on sound', () => {
  const source = `on click
  loop "bd hh"
  tell sound to play "sd"
  tell drums to play "kick"
  put "a b" into x
  loop x
  loop "a" & "b"
end click`;
  expect(patternTexts(source).map(t => t.text)).toEqual(['bd hh', 'sd']);
  const [text] = patternTexts(source);
  expect(source.slice(text!.offset, text!.offset + 5)).toBe('bd hh');
});

test('known names and whole sound names pass', () => {
  expect(
    patternProblems(
      'on click\n  loop "bd [hh hh] sd:2, - bd"\n  play "Door Creak"\nend click',
      names,
    ),
  ).toEqual([]);
});

test('unknown names are reported against the line and the word', () => {
  const source = 'on click\n  loop "bd cp:2 hh"\nend click';
  expect(patternProblems(source, names)).toEqual([
    {
      from: source.indexOf('cp'),
      to: source.indexOf('cp') + 4,
      line: 2,
      // Music has only one cp, so it can't offer cp:2.
      message: 'No sound is named “cp:2”.',
    },
  ]);
});

test('syntax errors are reported where they are', () => {
  const source = 'on click\n\n  tell sound to loop "bd [hh"\nend click';
  expect(patternProblems(source, names)).toEqual([
    {
      from: source.indexOf('['),
      to: source.indexOf('[') + 1,
      line: 3,
      message: 'This “[” has no “]”.',
    },
  ]);
});

test('the editor underlines the same problems', () => {
  const source = 'on click\n  loop "bd zz"\nend click';
  expect(patternDiagnostics(source, names)).toEqual([
    {
      code: 'mini-notation',
      message: 'No sound is named “zz”.',
      range: {
        start: { line: 1, character: 11 },
        end: { line: 1, character: 13 },
      },
      severity: 1,
      source: 'folio',
    },
  ]);
});

test('a Script’s pattern problems are reported when it loads, and it still loads', () => {
  const project = createProject('Beats');
  project.assets.push({
    name: 'bd',
    fileName: 'bd.wav',
    hash: 'a'.repeat(64),
    mediaType: 'audio/wav',
    size: 3,
  });
  // Only the Project's own sounds (ADR 0161).
  expect(projectPatternNames(project).sounds).toEqual(new Set(['bd']));
  const button = createElement('button', 'button1');
  button.script = 'on click\n  loop "bd [zz"\nend click\non hello\nend hello';
  project.pages[0]!.elements.push(button);
  const play = new PlaySession(project);
  expect(play.problems).toEqual([
    { owner: button, line: 2, message: 'This “[” has no “]”.' },
  ]);
  expect(play.group.script('element:page1/button1')).toBeDefined();
});

test('a pattern `on` an Instrument is checked as its kind plays', () => {
  const instruments = new Map([
    ['bass', false],
    ['drums', true],
  ]);
  const source =
    'on click\n  loop "c3 e3 zz" on bass with {gain: 0.5}\n  loop "bd zz" on drums\n  loop "zz" on other\n  play "Door Creak" on drums\nend click';
  expect(
    patternProblems(source, { ...names, instruments }).map(
      p => `${p.line} ${p.message}`,
    ),
  ).toEqual([
    '2 “zz” is not a note bass can play.',
    '3 No sound is named “zz”.',
    // A whole Project sound's name plays only without `on`.
    '5 No sound is named “Door”.',
    '5 No sound is named “Creak”.',
  ]);
});

test('backtick and raw texts without holes are checked too (#2173)', () => {
  const instruments = new Map([['lead', false]]);
  const source = [
    'on openScript',
    '  loop `',
    '    c4 e4',
    '      g4 zz9',
    '    ` on lead',
    '  tell sound to play """bd [zz"""',
    '  loop `c4 ${"zz"}` on lead',
    'end openScript',
  ].join('\n');
  expect(patternTexts(source).map(t => t.text)).toEqual([
    'c4 e4\n  g4 zz9',
    'bd [zz',
  ]);
  const problems = patternProblems(source, { ...names, instruments });
  expect(
    problems.map(p => [p.line, source.slice(p.from, p.to), p.message]),
  ).toEqual([
    [4, 'zz9', '“zz9” is not a note lead can play.'],
    [6, '[', 'This “[” has no “]”.'],
  ]);
  expect(
    patternDiagnostics(source, { ...names, instruments })[0]!.range,
  ).toEqual({
    start: { line: 3, character: 9 },
    end: { line: 3, character: 12 },
  });
});

test('escapes and inline backtick text map to their source', () => {
  const instruments = new Map([['lead', false]]);
  const source = 'on x\n  loop `c4\\nzz \\x41\\u{42}` on lead\nend x';
  expect(
    patternProblems(source, { ...names, instruments }).map(p =>
      source.slice(p.from, p.to),
    ),
  ).toEqual(['zz', String.raw`\x41\u{42}`]);
});

test('a Project needs Instrument audio for Instruments or a pattern word', () => {
  const p = createProject('Quiet');
  expect(needsInstrumentAudio(p)).toBe(false);
  p.pages[0]!.script = 'on openPage\n  loop "bd hh"\nend openPage';
  expect(needsInstrumentAudio(p)).toBe(true);
});

test('a Project knows only its own sounds, and a Music name says where to get it (ADR 0161)', () => {
  const project = createProject('Blank');
  expect(projectPatternNames(project).sounds).toEqual(new Set());
  const source = 'on click\n  loop "bd bd:1 zz"\nend click';
  expect(
    patternProblems(source, projectPatternNames(project)).map(p => [
      source.slice(p.from, p.to),
      p.message,
    ]),
  ).toEqual([
    [
      'bd',
      'No sound is named “bd”. Add it with Project ▸ Add Sound from Music….',
    ],
    [
      'bd:1',
      'No sound is named “bd:1”. Add it with Project ▸ Add Sound from Music….',
    ],
    ['zz', 'No sound is named “zz”.'],
  ]);
  for (const name of ['bd', 'bd:1', 'zz']) {
    project.assets.push({
      name,
      fileName: `${name}.wav`,
      hash: name.padEnd(64, '0'),
      mediaType: 'audio/wav',
      size: 3,
    });
  }
  expect(patternProblems(source, projectPatternNames(project))).toEqual([]);
});

test('sounds named in literal patterns decode first, then the rest; never images (#1958)', () => {
  const project = createProject('Order');
  for (const [name, mediaType] of [
    ['zap', 'audio/wav'],
    ['bd', 'audio/wav'],
    ['Door Creak', 'audio/wav'],
    ['lamp', 'image/png'],
    ['hh', 'audio/wav'],
    ['bd:1', 'audio/wav'],
  ] as const) {
    project.assets.push({
      name,
      fileName: `${name}.x`,
      hash: name.padEnd(64, '0'),
      mediaType,
      size: 3,
    });
  }
  project.pages[0]!.script =
    'on openPage\n  loop "bd:1 [hh hh]"\n  play "Door Creak"\nend openPage';
  project.libraries.push({
    name: 'beats',
    source: 'on fill\n  play "zap"\nend fill',
  });
  expect(soundDecodeOrder(project)).toEqual({
    named: ['bd:1', 'hh', 'Door Creak', 'zap'],
    later: ['bd'],
  });
});
