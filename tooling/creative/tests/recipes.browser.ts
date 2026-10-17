// Dedicated test page without main.js; exercises the real Info and Script windows.
import { EditorView } from '@codemirror/view';
import { createElement, createPage, createProject } from '../src/model';
import { mountStack } from '../src/stack';
const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const win = () => document.querySelector<HTMLElement>('.script-window.front')!;
const view = () => EditorView.findFromDOM(win().querySelector('.cm-editor')!)!;
const picker = () => win().querySelector<HTMLElement>('.recipe-picker')!;
const choose = (label: string, value: string) => {
  const input = picker().querySelector<HTMLSelectElement>(
    `[aria-label="${label}"]`,
  )!;
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
};
const button = (text: string) =>
  [...picker().querySelectorAll('button')].find(b => b.textContent === text)!;
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
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const test = (name: string, run: () => void) => {
    try {
      run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  };
  test('Info opens a picker; navigation is one selected, undoable edit', () => {
    document.querySelector<HTMLButtonElement>('#info [data-recipe]')!.click();
    assert(picker(), 'Info shortcut opens picker');
    choose('Target', '1');
    button('Preview insertion').click();
    assert(
      picker()
        .querySelector('mark')!
        .textContent!.includes('tell pages to show cellar'),
      'Full source preview highlights insertion',
    );
    button('Insert action').click();
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
  test('existing click previews start/end, adds no duplicate, and rejects stale preview', () => {
    add();
    choose('Action', 'hide');
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
    button('Preview insertion').click();
    button('Insert action').click();
    assert(
      view().state.doc.toString() ===
        'on click\n  set the visible of me to false\n  tell pages to show cellar\nend click\n',
      'Action inserted before navigation',
    );
    add();
    button('Preview insertion').click();
    view().dispatch({ changes: { from: 0, insert: '-- edited\n' } });
    button('Insert action').click();
    assert(
      button('Insert action').disabled,
      'Stale preview must be regenerated',
    );
    button('Cancel').click();
  });
  test('complex handlers require explicit cursor placement', () => {
    view().dispatch({
      changes: {
        from: 0,
        to: view().state.doc.length,
        insert: 'on click\n  if true then return\nend click\n',
      },
    });
    add();
    choose('Action', 'show');
    assert(button('Use current cursor and preview'), 'Explicit cursor preview');
    view().dispatch({ selection: { anchor: 9 } });
    button('Use current cursor and preview').click();
    button('Insert action').click();
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
  test('Project picker offers navigation and sounds; read-only closes and disables picker', () => {
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
