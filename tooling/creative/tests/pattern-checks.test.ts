import { expect, test } from 'bun:test';
import { KIT_SAMPLE_NAMES } from '../src/kits/kits';
import { createElement, createProject } from '../src/model';
import {
  needsInstrumentAudio,
  patternDiagnostics,
  patternProblems,
  patternTexts,
  projectPatternNames,
} from '../src/pattern-checks';
import { PlaySession } from '../src/play';

const names = { sounds: new Set(['bd', 'hh', 'sd', 'Door Creak']) };

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
      to: source.indexOf('cp') + 2,
      line: 2,
      message: 'No sound or sample is named “cp”.',
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
      message: 'No sound or sample is named “zz”.',
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
  // The Project's sounds join the built-in kits' samples.
  const sounds = projectPatternNames(project).sounds;
  expect(sounds).toEqual(new Set([...KIT_SAMPLE_NAMES, 'bd']));
  expect(sounds.has('oh')).toBe(true);
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
    '3 No sound or sample is named “zz”.',
    // A whole Project sound's name plays only without `on`.
    '5 No sound or sample is named “Door”.',
    '5 No sound or sample is named “Creak”.',
  ]);
});

test('a Project needs Instrument audio for Instruments or a pattern word', () => {
  const p = createProject('Quiet');
  expect(needsInstrumentAudio(p)).toBe(false);
  p.pages[0]!.script = 'on openPage\n  loop "bd hh"\nend openPage';
  expect(needsInstrumentAudio(p)).toBe(true);
});
