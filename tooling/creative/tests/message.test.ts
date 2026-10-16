import { expect, test } from 'bun:test';
import { StackEditor } from '../src/editing';
import { runInEdit, settle } from '../src/message';
import { createElement, createPage, createProject } from '../src/model';
import { PlaySession } from '../src/play';

const fixture = () => {
  const project = createProject('Story');
  project.pages[0]!.elements.push(createElement('button', 'button1'));
  project.pages.push(createPage('page2'));
  return project;
};

const run = async (play: PlaySession, command: string) => {
  const started = play.runMessage(command);
  return started.ok
    ? settle(play, started.result, () => play.pump(0n))
    : { error: started.error };
};

test('a command changes Play State and an expression prints its value', async () => {
  const project = fixture();
  const before = structuredClone(project);
  const play = new PlaySession(project);
  expect(await run(play, 'set the visible of button1 to false')).toEqual({
    text: undefined,
  });
  expect(play.page.elements[0]!.visible).toBe(false);
  expect(await run(play, 'the label of button1')).toEqual({ text: 'Button' });
  expect(await run(play, '3 + 4')).toEqual({ text: '7' });
  expect(project).toEqual(before);
  expect(play.problems).toEqual([]);
});

test('errors name the command line, not the Errors window', async () => {
  const play = new PlaySession(fixture());
  expect(await run(play, '1 / 0')).toEqual({
    error: 'line 1: Division by zero',
  });
  expect((await run(play, 'set x to')).error).toContain('line 1');
  expect(play.problems).toEqual([]);
});

test('in Edit a command is one undoable authored edit that keeps identities', async () => {
  const project = fixture();
  const editor = new StackEditor(project);
  const button = project.pages[0]!.elements[0]!;
  expect(await runInEdit(editor, 'set the label of button1 to "Go"')).toEqual({
    text: undefined,
  });
  expect(project.pages[0]!.elements[0]).toBe(button);
  expect(button).toHaveProperty('label', 'Go');
  editor.undo();
  expect(project.pages[0]!.elements[0]).toHaveProperty('label', 'Button');
});

test('in Edit, created Elements are kept and navigation moves the editor', async () => {
  const editor = new StackEditor(fixture());
  await runInEdit(editor, 'ask elements to create "rectangle", thisPage');
  expect(editor.page.elements.map(e => e.kind)).toEqual([
    'button',
    'rectangle',
  ]);
  await runInEdit(editor, 'tell pages to show page2');
  expect(editor.page.name).toBe('page2');
});

test('in Edit, a failing command changes nothing and read-only refuses', async () => {
  const project = fixture();
  const editor = new StackEditor(project);
  const before = structuredClone(project);
  expect(
    (
      await runInEdit(
        editor,
        'set the label of button1 to "X"\n put 1 / 0 into y',
      )
    ).error,
  ).toContain('Division by zero');
  expect(project).toEqual(before);
  expect(editor.canUndo).toBe(false);
  editor.readOnly = true;
  expect(
    (await runInEdit(editor, 'set the label of button1 to "X"')).error,
  ).toContain('read-only');
  expect(project).toEqual(before);
});
