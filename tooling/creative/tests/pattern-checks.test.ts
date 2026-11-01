import { expect, test } from 'bun:test';
import { createElement, createProject } from '../src/model';
import {
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
  expect(projectPatternNames(project).sounds).toEqual(new Set(['bd']));
  const button = createElement('button', 'button1');
  button.script = 'on click\n  loop "bd [cp"\nend click\non hello\nend hello';
  project.pages[0]!.elements.push(button);
  const play = new PlaySession(project);
  expect(play.problems).toEqual([
    { owner: button, line: 2, message: 'This “[” has no “]”.' },
  ]);
  expect(play.group.script('element:page1/button1')).toBeDefined();
});
