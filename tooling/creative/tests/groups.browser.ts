// Dedicated page: exercise real menu/input/rendering alongside grouped Play.
import { createElement, createProject } from '../src/model';
import { groupElement } from '../src/tree/rules';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const wait = () => new Promise(resolve => setTimeout(resolve, 30));
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return;
    }
    await wait();
  }
  throw new Error('Timed out');
};
const project = createProject('Group browser checks');
const a = { ...createElement('button', 'a'), left: 20, top: 30 };
const b = { ...createElement('button', 'b'), left: 300, top: 30 };
project.pages[0]!.elements = [a, b];
export const shell = mountStack(project);
mountPlay(shell);
const { editor } = shell;
const node = (name: string, reader = false) =>
  document.querySelector<HTMLElement>(
    `${reader ? '#reader' : '#page'} [data-element="${name}"]`,
  )!;
const menu = (name: string) =>
  document.querySelector<HTMLButtonElement>(
    `#edit-menu [data-command="${name}"]`,
  )!;
const key = (key: string, ctrlKey = false, shiftKey = false) =>
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      ctrlKey,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
const mode = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('#tool-modes button')].find(
    b => b.textContent?.includes(name),
  )!;

export const runBrowserTests = async () => {
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const test = async (name: string, run: () => void | Promise<void>) => {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  };
  await test('Menu groups a selection, click resolves members to group, double-click enters, Escape exits', async () => {
    editor.click('a');
    editor.click('b', { shift: true });
    await wait();
    assert(!menu('group').disabled, 'Group enabled for siblings');
    menu('group').click();
    await wait();
    assert(editor.selection[0] === 'group1', 'Group selected');
    assert(
      !document.querySelector('#page [data-handle]'),
      'Group has no resize handles',
    );
    assert(
      document.querySelector<HTMLInputElement>('#info [data-field="width"]')!
        .disabled,
      'Group width is read-only',
    );
    node('a').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
    );
    assert(editor.selection[0] === 'group1', 'Member click selects composite');
    node('a').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await wait();
    assert(editor.scope.length === 1, 'Double-click enters');
    node('a').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
    );
    assert(editor.selection[0] === 'a', 'Entered member selectable');
    key('Escape');
    await wait();
    assert(
      editor.scope.length === 0 && editor.selection[0] === 'group1',
      'Escape selects exited group',
    );
    key('g', true, true);
    await wait();
    assert(!editor.element('group1'), 'Ungroup shortcut runs');
    key('z', true);
    await wait();
    assert(editor.element('group1'), 'Undo restores group');
  });
  await test('Info moves all members together and Undo restores coordinates', async () => {
    editor.click('group1');
    await wait();
    const field = document.querySelector<HTMLInputElement>(
      '#info [data-field="left"]',
    )!;
    field.value = '50';
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await wait();
    assert(
      node('a').style.left === '50px' && node('b').style.left === '330px',
      'Whole composite translates',
    );
    editor.undo();
    await wait();
    assert(node('a').style.left === '20px', 'Undo restores member position');
  });
  await test('Empty groups have a selectable marker', async () => {
    const empty = groupElement('empty', []);
    empty.left = 600;
    empty.top = 400;
    editor.edit(({ project, tree }) => {
      tree.insert(project.pages[0]!, empty);
    });
    await wait();
    const marker = node('empty');
    assert(
      marker.getBoundingClientRect().width >= 10,
      'Empty marker has hit area',
    );
    marker.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
    );
    assert(editor.selection[0] === 'empty', 'Empty marker selects group');
  });
  await test('Browse and Present route member clicks through group and hide descendants, with transparent gaps', async () => {
    editor.edit(({ project, tree }) => {
      const group = project.pages[0]!.elements[0]!;
      const entry = createElement('text', 'entry');
      if (group.kind === 'group' && entry.kind === 'text') {
        entry.editable = true;
        entry.top = 150;
        tree.insert(group, entry);
      }
      tree.setScript(
        project.pages[0]!.elements[0]!,
        'on click {button: 0}\n hide me\nend',
      );
    });
    for (const playMode of ['Browse', 'Present']) {
      const present = document.querySelector<HTMLButtonElement>(
        '#menu [aria-pressed]',
      )!;
      (playMode === 'Browse' ? mode('Browse') : present).click();
      await wait();
      assert(
        !document.querySelector('#reader [data-element="group1"]'),
        'Group has no reader hit area',
      );
      const left = node('a', true).getBoundingClientRect();
      const right = node('b', true).getBoundingClientRect();
      const gap = document.elementFromPoint(
        (left.right + right.left) / 2,
        left.top + 10,
      );
      assert(!gap?.closest('[data-element]'), 'Gap passes through composite');
      const entry = node('entry', true);
      entry.focus();
      assert(
        document.activeElement === entry && entry.contentEditable === 'true',
        'Grouped reader text takes focus',
      );
      entry.innerText = 'Reader edit';
      entry.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await wait();
      assert(
        document.activeElement === entry,
        'Reader redraw preserves grouped text focus',
      );
      node('a', true).click();
      await until(() => node('a', true).hidden === true);
      assert(node('b', true).hidden, 'Group Script hides all members');
      assert(
        entry.hidden && entry.contentEditable === 'false',
        'Hidden ancestor ends reader text editing',
      );
      (playMode === 'Browse' ? mode('Edit') : present).click();
      await wait();
      assert(
        !node('a').classList.contains('hidden'),
        'Stop restores authored visibility',
      );
    }
  });
  return results;
};
