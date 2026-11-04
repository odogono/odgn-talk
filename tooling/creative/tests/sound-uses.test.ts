import { expect, test } from 'bun:test';
import { StackEditor } from '../src/editing';
import { createInstrument } from '../src/instruments/registry';
import { SYNTH_KIND } from './helpers/instruments';
import { createElement, createProject, type Asset } from '../src/model';
import { renameSoundIn, soundNameProblem, soundUses } from '../src/sound-uses';

const sound = (name: string, hash = name): Asset => ({
  name,
  fileName: `${name}.wav`,
  hash: hash.padEnd(64, '0'),
  mediaType: 'audio/wav',
  size: 3,
});

const beats = () => {
  const project = createProject('Beats');
  project.assets.push(sound('bd'), sound('sn'), sound('rain drops', 'c'));
  project.instruments.push(
    createInstrument('sampler', 'drums'),
    createInstrument(SYNTH_KIND, 'bass'),
  );
  const button = createElement('button', 'button1');
  button.script = [
    'on click',
    '  loop "bd sn bd*2"',
    '  play "bd" on drums',
    '  play "bd" on bass',
    '  tell sound to play "rain drops"',
    '  put "bd" into name',
    'end click',
  ].join('\n');
  project.pages[0]!.elements.push(button);
  project.libraries.push({
    name: 'kit',
    source: 'on hit\n  play "bd:1 bd"\nend hit',
  });
  return { project, button };
};

test('a sound’s uses are its literal pattern words and whole-name texts', () => {
  const { project } = beats();
  expect(soundUses(project, 'bd')).toEqual([
    { where: 'button1', line: 2 },
    { where: 'button1', line: 2 },
    { where: 'button1', line: 3 },
    { where: 'Library kit', line: 2 },
  ]);
  expect(soundUses(project, 'rain drops')).toEqual([
    { where: 'button1', line: 5 },
  ]);
});

test('renaming rewrites samplers’ words, not notes, other indexes or plain strings', () => {
  const samplers = new Set(['drums']);
  expect(
    renameSoundIn(
      'on go\n  loop "bd sn bd*2"\n  play "bd" on bass\n  play "bd:1" on drums\n  put "bd" into x\nend go',
      'bd',
      'kick',
      samplers,
    ),
  ).toBe(
    'on go\n  loop "kick sn kick*2"\n  play "bd" on bass\n  play "bd:1" on drums\n  put "bd" into x\nend go',
  );
});

test('a new name must be free, quote-free and a word where patterns need one', () => {
  const { project } = beats();
  expect(soundNameProblem(project, 'bd', 'sn')).toContain('already');
  expect(soundNameProblem(project, 'bd', 'a"b')).toContain('quotes');
  expect(soundNameProblem(project, 'bd', ' ')).toContain('empty');
  expect(soundNameProblem(project, 'bd', 'big kick')).toContain('one word');
  expect(soundNameProblem(project, 'bd', 'kick:2')).toBeUndefined();
  // Played only by its whole name, so any name will do.
  expect(soundNameProblem(project, 'rain drops', 'soft rain')).toBeUndefined();
});

test('renaming a sound rewrites its uses as one undoable edit', () => {
  const { project } = beats();
  const editor = new StackEditor(project);
  expect(editor.renameSound('bd', 'kick')).toBeUndefined();
  const script = editor.project.pages[0]!.elements[0]!.script!;
  expect(script).toContain('loop "kick sn kick*2"');
  expect(script).toContain('play "kick" on drums');
  expect(script).toContain('play "bd" on bass');
  expect(editor.project.libraries[0]!.source).toContain('play "bd:1 kick"');
  expect(editor.project.assets.map(a => a.name)).toEqual([
    'kick',
    'sn',
    'rain drops',
  ]);
  editor.undo();
  expect(editor.project.assets[0]!.name).toBe('bd');
  expect(editor.project.pages[0]!.elements[0]!.script).toContain(
    'loop "bd sn bd*2"',
  );
  expect(editor.project.libraries[0]!.source).toContain('play "bd:1 bd"');
  expect(editor.renameSound('bd', 'sn')).toContain('already');
  expect(editor.project.assets[0]!.name).toBe('bd');
});

test('removing a sound leaves its uses and Undo brings it back', () => {
  const { project } = beats();
  const editor = new StackEditor(project);
  editor.removeSound('sn');
  expect(editor.project.assets.map(a => a.name)).toEqual(['bd', 'rain drops']);
  expect(editor.project.pages[0]!.elements[0]!.script).toContain('bd sn');
  editor.undo();
  expect(editor.project.assets.map(a => a.name)).toEqual([
    'bd',
    'sn',
    'rain drops',
  ]);
});
