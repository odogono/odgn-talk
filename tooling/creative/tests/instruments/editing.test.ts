import { expect, test } from 'bun:test';
import { StackEditor } from '../../src/editing';
import { createElement, createProject } from '../../src/model';
import { readProjectFile, writeProjectFile } from '../../src/project-file';

const editor = () => {
  const project = createProject('Band');
  project.pages[0]!.elements.push(createElement('button', 'go'));
  return new StackEditor(project);
};

test('adding gives each Instrument a fresh name and an id', () => {
  const e = editor();
  e.edit(({ tree }) => {
    tree.addInstrument('synth', 'synth');
    tree.addInstrument('synth', 'synth');
    tree.addInstrument('sampler', 'go');
  });
  const [first, second, third] = e.project.instruments;
  expect([first!.name, second!.name, third!.name]).toEqual([
    'synth',
    'synth2',
    'go2',
  ]);
  expect(new Set(e.project.instruments.map(i => i.id)).size).toBe(3);
  expect(() =>
    e.edit(({ tree }) => tree.addInstrument('theremin', 'theremin')),
  ).toThrow('There is no Instrument kind “theremin”');
});

test('changes are checked, undoable and saved', async () => {
  const e = editor();
  const id = e.edit(({ tree }) => tree.addInstrument('synth', 'synth').id!);
  e.edit(({ tree }) => {
    tree.changeInstrument(id, { parameter: 'cutoff', value: 900 });
    tree.changeInstrument(id, { voices: 2 });
    tree.changeInstrument(id, { name: 'bass' });
  });
  expect(e.project.instruments[0]).toMatchObject({
    name: 'bass',
    voices: 2,
    parameters: { cutoff: 900 },
  });
  for (const [change, message] of [
    [{ parameter: 'cutoff', value: 5 }, 'Expected a number from 20 to 20000.'],
    [{ parameter: 'wobble', value: 1 }, 'A synth has no parameter “wobble”.'],
    [{ voices: 17 }, 'Expected a whole number from 1 to 16.'],
    [{ name: 'go' }, '“go” is already the name of a Page or Element.'],
    [{ name: 'page1' }, '“page1” is already the name of a Page or Element.'],
    [{ name: 'sound' }, '“sound” is already a name Scripts use.'],
    [{ name: 'two words' }, 'Expected a name made of letters, digits and _.'],
  ] as const) {
    expect(() =>
      e.edit(({ tree }) => tree.changeInstrument(id, change)),
    ).toThrow(message);
  }
  expect(e.project.instruments[0]!.name).toBe('bass');
  e.undo();
  expect(e.project.instruments[0]).toMatchObject({
    name: 'synth',
    voices: 8,
    parameters: { cutoff: 4000 },
  });
  e.redo();
  const { project } = await readProjectFile(
    await writeProjectFile(e.project, new Map()),
  );
  expect(project.instruments[0]).toMatchObject({ name: 'bass', voices: 2 });
});

test('removing an Instrument is undoable', () => {
  const e = editor();
  const id = e.edit(({ tree }) => tree.addInstrument('ym2149', 'chip').id!);
  e.edit(({ tree }) => tree.removeInstrument(id));
  expect(e.project.instruments).toEqual([]);
  e.undo();
  expect(e.project.instruments.map(i => i.name)).toEqual(['chip']);
});

test('an Element or Page cannot be renamed to an Instrument name', () => {
  const e = editor();
  e.edit(({ tree }) => tree.addInstrument('synth', 'bass'));
  expect(e.renameElement('go', 'bass').ok).toBe(false);
  expect(e.renamePage('bass').ok).toBe(false);
});
