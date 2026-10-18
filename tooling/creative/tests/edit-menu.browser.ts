// Dedicated page without main.js; checks the Edit menu's commands in the real shell.
import { createElement, createPage, createProject } from '../src/model';
import { mountStack } from '../src/stack';

const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const ALL = [
  'undo',
  'redo',
  'duplicate',
  'delete',
  'group',
  'ungroup',
  'forward',
  'backward',
  'front',
  'back',
];
const SELECTED = [
  'duplicate',
  'delete',
  'forward',
  'backward',
  'front',
  'back',
];

/** The enabled commands, in menu order. */
const enabled = () =>
  [...document.querySelectorAll<HTMLButtonElement>('#edit-menu [data-command]')]
    .filter(button => !button.disabled)
    .map(button => button.dataset.command!);
const expectEnabled = async (expected: string[], message: string) => {
  await settle();
  const actual = enabled();
  if (actual.join() !== expected.join()) {
    throw new Error(
      `${message}: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    );
  }
};
const command = (name: string) =>
  document.querySelector<HTMLButtonElement>(
    `#edit-menu [data-command="${name}"]`,
  )!;
const press = (key: string, shiftKey = false) =>
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key,
      shiftKey,
    }),
  );

const project = createProject('Edit menu');
project.pages[0]!.elements.push(
  createElement('rectangle', 'box'),
  createElement('button', 'go'),
);
project.pages.push(createPage('second'));
export const shell = mountStack(project);
const { editor } = shell;

export const runBrowserTests = async () => {
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const test = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  };

  await test('Menu keeps its labels and shortcut hints', async () => {
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '#edit-menu [data-command]',
      ),
    ];
    if (buttons.map(b => b.dataset.command).join() !== ALL.join()) {
      throw new Error('Commands are missing or out of order');
    }
    const labels = buttons.map(button => button.textContent);
    const expected = [
      'Undo ⌘Z',
      'Redo ⇧⌘Z',
      'Duplicate ⌘D',
      'Delete ⌫',
      'Group ⌘G',
      'Ungroup ⇧⌘G',
      'Bring forward',
      'Send backward',
      'Bring to front',
      'Send to back',
    ];
    if (labels.join('|') !== expected.join('|')) {
      throw new Error(`Labels were ${JSON.stringify(labels)}`);
    }
  });

  await test('Commands follow the selection', async () => {
    await expectEnabled(['duplicate'], 'Nothing selected');
    editor.click('box');
    await expectEnabled(SELECTED, 'One Element selected');
    editor.click('go', { shift: true });
    await expectEnabled(
      [...SELECTED.slice(0, 2), 'group', ...SELECTED.slice(2)],
      'Two Elements selected',
    );
    editor.selectPage();
    await expectEnabled(['duplicate', 'delete'], 'Page selected');
  });

  await test('Undo and redo follow the history, from menu and keys', async () => {
    editor.click('box');
    // A disabled button ignores clicks, so wait for the menu to render.
    await settle();
    command('forward').click();
    await expectEnabled(['undo', ...SELECTED], 'After an edit');
    command('undo').click();
    await expectEnabled(['redo', ...SELECTED], 'After undo from the menu');
    press('z', true);
    await expectEnabled(['undo', ...SELECTED], 'After redo from the keyboard');
    press('z');
    await expectEnabled(['redo', ...SELECTED], 'After undo from the keyboard');
    shell.editor.replaceProject(project);
    await expectEnabled(['duplicate'], 'A loaded Project has no history');
  });

  await test('Read-only disables every command', async () => {
    editor.click('box');
    editor.orderLayers('front');
    editor.orderLayers('back');
    editor.undo();
    await expectEnabled(['undo', 'redo', ...SELECTED], 'Before read-only');
    shell.setReadOnly(true);
    await expectEnabled([], 'Read-only');
    shell.setReadOnly(false);
    await expectEnabled(['undo', 'redo', ...SELECTED], 'Editable again');
  });

  await test('Browse allows only undo and redo; Present allows nothing', async () => {
    editor.click('box');
    shell.setPlaying('browse');
    await expectEnabled(['undo', 'redo'], 'Browse');
    shell.setPlaying('present');
    await expectEnabled([], 'Present');
    shell.setPlaying(undefined);
    await expectEnabled(['undo', 'redo', ...SELECTED], 'Edit');
    shell.setPlaying('browse');
    shell.editor.replaceProject(project);
    await expectEnabled([], 'Browse with no history');
    shell.setPlaying(undefined);
    await expectEnabled(['duplicate'], 'Edit with no history');
  });

  await test('Choosing a command runs it and closes the menu', async () => {
    const menu = document.querySelector<HTMLDetailsElement>('#edit-menu')!;
    menu.open = true;
    editor.click('box');
    await settle();
    command('delete').click();
    await settle();
    if (menu.open) {
      throw new Error('Edit menu stayed open');
    }
    if (editor.page.elements.some(e => e.name === 'box')) {
      throw new Error('Delete did not run');
    }
    await expectEnabled(['undo', 'duplicate'], 'After delete');
    shell.editor.replaceProject(project);
  });

  return results;
};
