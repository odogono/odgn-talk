// Dedicated test page without main.js; exercises the real Info and Script windows.
import { EditorView } from '@codemirror/view';
import { createElement, createPage, createProject } from '../src/model';
import { mountStack } from '../src/stack';
const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for Info');
};
const win = () => document.querySelector<HTMLElement>('.script-window.front')!;
const view = () => EditorView.findFromDOM(win().querySelector('.cm-editor')!)!;
const picker = () => win().querySelector<HTMLElement>('.recipe-picker')!;
// The picker re-renders on Preact's render queue after each input.
const settle = () => new Promise(resolve => setTimeout(resolve));
const field = <T extends HTMLElement>(label: string) =>
  picker().querySelector<T>(`[aria-label="${label}"]`)!;
const choose = async (label: string, value: string) => {
  const input = field<HTMLSelectElement>(label);
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
};
const button = (text: string) =>
  [...picker().querySelectorAll('button')].find(b => b.textContent === text)!;
const click = async (text: string) => {
  button(text).click();
  await settle();
};
const add = () =>
  win().querySelector<HTMLButtonElement>('.add-action')!.click();
export const runBrowserTests = async () => {
  const project = createProject('Recipe browser check');
  project.pages.push(createPage('cellar'));
  project.pages[0]!.elements.push(
    createElement('button', 'door'),
    createElement('text', 'clue'),
  );
  const shell = mountStack(project);
  shell.editor.click('door');
  shell.redraw();
  // Info follows selection on Preact's render queue.
  await until(
    () =>
      !!document.querySelector('#info [data-script="element"][data-recipe]'),
  );
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const test = async (name: string, run: () => Promise<void> | void) => {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  };
  await test('Info opens a picker; navigation is one selected, undoable edit', async () => {
    document.querySelector<HTMLButtonElement>('#info [data-recipe]')!.click();
    assert(picker(), 'Info shortcut opens picker');
    await choose('Target', '1');
    await click('Preview insertion');
    assert(
      picker()
        .querySelector('mark')!
        .textContent!.includes('tell pages to show cellar'),
      'Full source preview highlights insertion',
    );
    await click('Insert action');
    assert(
      shell.editor.project.pages[0]!.elements[0]!.script ===
        'on click\n  tell pages to show cellar\nend click\n',
      'Source inserted',
    );
    assert(
      view()
        .state.sliceDoc(
          view().state.selection.main.from,
          view().state.selection.main.to,
        )
        .includes('tell pages'),
      'Inserted source selected',
    );
    shell.editor.undo();
    shell.redraw();
    assert(view().state.doc.length === 0, 'One undo removes whole Recipe');
    shell.editor.redo();
    shell.redraw();
    assert(
      view().state.doc.toString().includes('show cellar'),
      'Redo restores Recipe',
    );
  });
  await test('existing click previews start/end, adds no duplicate, and rejects stale preview', async () => {
    add();
    await choose('Action', 'hide');
    assert(
      picker().querySelector<HTMLSelectElement>('[aria-label="Target"]')!
        .selectedOptions[0]!.textContent === 'door',
      'Owner is default',
    );
    assert(
      picker().querySelector<HTMLSelectElement>(
        '[aria-label="Insertion position"]',
      )!.value === 'start',
      'Property default is start',
    );
    assert(button('Insert action').disabled, 'Preview required');
    await click('Preview insertion');
    await click('Insert action');
    assert(
      view().state.doc.toString() ===
        'on click\n  set the visible of me to false\n  tell pages to show cellar\nend click\n',
      'Action inserted before navigation',
    );
    add();
    await click('Preview insertion');
    view().dispatch({ changes: { from: 0, insert: '-- edited\n' } });
    await click('Insert action');
    assert(
      button('Insert action').disabled,
      'Stale preview must be regenerated',
    );
    await click('Cancel');
  });
  await test('complex handlers require explicit cursor placement', async () => {
    view().dispatch({
      changes: {
        from: 0,
        to: view().state.doc.length,
        insert: 'on click\n  if true then return\nend click\n',
      },
    });
    add();
    await choose('Action', 'show');
    assert(button('Use current cursor and preview'), 'Explicit cursor preview');
    view().dispatch({ selection: { anchor: 9 } });
    await click('Use current cursor and preview');
    await click('Insert action');
    assert(
      view()
        .state.doc.toString()
        .startsWith('on click\n  set the visible of me to true\n'),
      'Chosen cursor used',
    );
    assert(
      view()
        .state.doc.toString()
        .match(/on click/g)?.length === 1,
      'No duplicate handler',
    );
  });
  await test('changing inputs updates the picker in place, keeps typed text and invalidates the preview', async () => {
    view().dispatch({
      changes: { from: 0, to: view().state.doc.length, insert: '' },
    });
    add();
    const action = field<HTMLSelectElement>('Action');
    const target = field<HTMLSelectElement>('Target');
    const text = field<HTMLTextAreaElement>('New text');
    const names = () => [...target.options].map(o => o.textContent).join(',');
    assert(document.activeElement === action, 'Action has focus on open');
    assert(text.closest('label')!.hidden, 'New text hidden for navigation');
    await choose('Action', 'text');
    assert(names() === 'door,clue', 'Change text offers button and text');
    assert(!text.closest('label')!.hidden, 'New text shown for Change text');
    text.value = 'Opened';
    text.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    await choose('Action', 'navigate');
    assert(
      names() === shell.editor.project.pages.map(p => p.name).join(','),
      'Navigation targets replace Element targets',
    );
    await choose('Action', 'text');
    assert(
      field('Action') === action &&
        field('Target') === target &&
        field('New text') === text,
      'Controls are kept, not rebuilt',
    );
    assert(text.value === 'Opened', 'Typed text survives action changes');
    assert(target.selectedOptions[0]!.textContent === 'door', 'Owner reset');
    await click('Preview insertion');
    assert(
      picker()
        .querySelector('mark')!
        .textContent!.includes('set the label of me to "Opened"'),
      'Preview uses typed text',
    );
    await choose('Target', '1');
    assert(button('Insert action').disabled, 'Target change needs preview');
    assert(!picker().querySelector('mark'), 'Target change clears preview');
    await click('Preview insertion');
    assert(
      picker().querySelector('mark')!.textContent!.includes('of clue to'),
      'Preview follows target',
    );
    text.value = 'Shut';
    text.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    assert(button('Insert action').disabled, 'Text change needs preview');
    await click('Preview insertion');
    view().dispatch({ changes: { from: 0, insert: '-- edited\n' } });
    await click('Insert action');
    assert(
      picker()
        .querySelector('[role="status"]')!
        .textContent!.startsWith('The Script or targets changed.'),
      'Stale preview explained',
    );
    assert(target.selectedOptions[0]!.textContent === 'door', 'Re-checked');
    assert(text.value === 'Shut', 'Re-check keeps typed text');
    await click('Cancel');
    assert(!win().querySelector('.recipe-picker'), 'Cancel closes picker');
  });
  await test('Project picker offers navigation and sounds; read-only closes and disables picker', async () => {
    shell.openScript(shell.editor.project);
    add();
    assert(
      [
        ...picker().querySelectorAll<HTMLOptionElement>(
          '[aria-label="Action"] option',
        ),
      ]
        .map(option => option.value)
        .join(',') === 'navigate,playSound,loopSound,stopSound',
      'Navigation and sounds for Project',
    );
    assert(
      picker().textContent!.includes('passed up'),
      'Message Path explained',
    );
    shell.setReadOnly(true);
    assert(!win().querySelector('.recipe-picker'), 'Read-only closes picker');
    assert(
      win().querySelector<HTMLButtonElement>('.add-action')!.disabled,
      'Cannot insert in read-only mode',
    );
  });
  shell.editor.replaceProject(createProject('Done'));
  shell.redraw();
  return results;
};
