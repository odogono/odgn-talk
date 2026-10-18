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

test('in Edit a command is one undoable authored edit that keeps session-local ids', async () => {
  const project = fixture();
  const editor = new StackEditor(project);
  const button = editor.page.elements[0]!;
  expect(await runInEdit(editor, 'set the label of button1 to "Go"')).toEqual({
    text: undefined,
  });
  expect(editor.page.elements[0]!.id).toBe(button.id);
  expect(editor.page.elements[0]).toBe(button);
  expect(editor.page.elements[0]).toHaveProperty('label', 'Go');
  editor.undo();
  expect(editor.page.elements[0]).toHaveProperty('label', 'Button');
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
  const before = editor.snapshot();
  expect(
    (
      await runInEdit(
        editor,
        'set the label of button1 to "X"\n put 1 / 0 into y',
      )
    ).error,
  ).toContain('Division by zero');
  expect(editor.project).toEqual(before);
  expect(editor.canUndo).toBe(false);
  editor.readOnly = true;
  expect(
    (await runInEdit(editor, 'set the label of button1 to "X"')).error,
  ).toContain('read-only');
  expect(editor.project).toEqual(before);
});

test('hide and show are Host Commands, whose errors name the command line', async () => {
  const play = new PlaySession(fixture());
  expect(await run(play, 'hide button1')).toEqual({ text: undefined });
  expect(play.page.elements[0]!.visible).toBe(false);
  expect(await run(play, 'show button1')).toEqual({ text: undefined });
  expect(play.page.elements[0]!.visible).toBe(true);
  expect(await run(play, 'hide 42')).toEqual({
    error: 'line 1: wrong argument',
  });
  const failed = await run(
    play,
    'put 1 into target\nhide target\nhide button1',
  );
  expect(failed.error).toMatch(/^line 2: Expected/u);
  expect(play.page.elements[0]!.visible).toBe(true);
  expect(play.problems).toEqual([]);
});

test('in Edit, hide is one undoable authored edit', async () => {
  const project = fixture();
  const editor = new StackEditor(project);
  expect(await runInEdit(editor, 'hide button1')).toEqual({ text: undefined });
  expect(editor.page.elements[0]!.visible).toBe(false);
  editor.undo();
  expect(editor.page.elements[0]!.visible).toBe(true);
});

test('expressions and unchanged writes preserve the root and redo history', async () => {
  const editor = new StackEditor(fixture());
  editor.renameElement('button1', 'renamed');
  editor.undo();
  const before = editor.state.value;
  expect(await runInEdit(editor, '3 + 4')).toEqual({ text: '7' });
  expect(await runInEdit(editor, 'show button1')).toEqual({ text: undefined });
  expect(editor.state.value).toBe(before);
  expect(editor.canUndo).toBe(false);
  expect(editor.canRedo).toBe(true);
});

test('Message Box clones get fresh ids while unchanged owners keep theirs', async () => {
  const editor = new StackEditor(fixture());
  const button = editor.element('button1')!;
  const page = editor.page.id;
  await runInEdit(editor, 'ask elements to clone button1');
  expect(editor.page.id).toBe(page);
  expect(editor.element('button1')).toBe(button);
  expect(editor.element('button2')!.id).toBeDefined();
  expect(editor.element('button2')!.id).not.toBe(button.id);
  editor.undo();
  expect(editor.element('button1')).toBe(button);
  expect(editor.element('button2')).toBeUndefined();
});

test('a stale Edit command cannot overwrite a newer edit, including edit then undo', async () => {
  for (const undo of [false, true]) {
    const editor = new StackEditor(fixture());
    const command = runInEdit(editor, 'set the label of button1 to "Stale"');
    editor.edit(({ project, tree }) =>
      tree.setProperty(project.pages[0]!.elements[0]!, 'label', 'Newer'),
    );
    if (undo) {
      editor.undo();
    }
    const before = editor.snapshot();
    expect((await command).error).toContain('Run it again');
    expect(editor.project).toEqual(before);
  }
});
