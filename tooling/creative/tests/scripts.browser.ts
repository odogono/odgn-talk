// Run on a dedicated page without main.js; see README.md.
import { EditorView } from '@codemirror/view';
import { createElement, createProject } from '../src/model';
import { mountStack } from '../src/stack';
import { Autosave } from '../src/autosave';
import { readProjectFile, writeProjectFile } from '../src/project-file';
import { openProjectStorage } from '../src/storage';

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
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for Script diagnostics');
};
const windows = () => [
  ...document.querySelectorAll<HTMLElement>('.script-window'),
];
const viewOf = (win: HTMLElement) =>
  EditorView.findFromDOM(win.querySelector('.cm-editor')!)!;
const source = 'on click\n  put the label of button1 into message\nend click\n';
const open = (name: string, shiftKey = false) => {
  document
    .querySelector(`#page [data-element="${name}"]`)!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, shiftKey }));
};
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
  const project = createProject('Script browser check');
  project.pages[0]!.elements = [
    createElement('button', 'button1'),
    createElement('text', 'text1'),
  ];
  const shell = mountStack(project);
  const storage = await openProjectStorage(indexedDB);
  const stored = await storage.saveProject(undefined, shell.editor.project);
  const autosave = new Autosave(async () => {
    await storage.saveProject(stored.id, shell.editor.project);
  });
  shell.editor.onChange = () => autosave.markDirty();
  await test('opening, Message Path, deduplication and authored edits', async () => {
    open('button1');
    const win = windows()[0]!;
    assert(windows().length === 1, 'Element Script opens');
    open('button1');
    assert(
      windows().length === 1 && win.classList.contains('front'),
      'Existing window comes forward',
    );
    const view = viewOf(win);
    view.dispatch({ changes: { from: 0, insert: source } });
    assert(
      shell.editor.project.pages[0]!.elements[0]!.script === source,
      'Script edits reach authored owner',
    );
    await until(
      () =>
        win.querySelector('.script-problems')!.textContent === '✓ No problems',
    );
    const path = win.querySelectorAll<HTMLButtonElement>(
      '.message-path button',
    );
    assert(path.length === 3, 'Element → Page → Project');
    path[1]!.click();
    path[2]!.click();
    assert(windows().length === 3, 'Page and Project Scripts open');
    for (const [index, other] of windows().slice(1).entries()) {
      viewOf(other).dispatch({
        changes: { from: 0, insert: `-- Script ${index}` },
      });
    }
    assert(
      shell.editor.project.script === '-- Script 1' &&
        shell.editor.project.pages[0]!.script === '-- Script 0',
      'All owner kinds are editable',
    );
  });
  await test('Script windows resize in both directions and the editor fills them', async () => {
    const win = windows()[0]!;
    assert(getComputedStyle(win).resize === 'both', 'Window has a resize grip');
    const view = viewOf(win);
    const before = view.dom.getBoundingClientRect();
    const original = { width: win.style.width, height: win.style.height };
    win.style.width = `${win.offsetWidth + 100}px`;
    win.style.height = `${win.offsetHeight + 100}px`;
    await new Promise(requestAnimationFrame);
    const after = view.dom.getBoundingClientRect();
    assert(after.width > before.width + 90, 'Editor grows with window width');
    assert(
      after.height > before.height + 90,
      'Editor grows with window height',
    );
    win.style.width = '340px';
    win.style.height = '280px';
    await new Promise(requestAnimationFrame);
    assert(
      view.dom.offsetWidth < before.width,
      'Editor shrinks with window width',
    );
    assert(
      view.dom.offsetHeight < before.height,
      'Editor shrinks with window height',
    );
    win.style.width = '3000px';
    win.style.height = '3000px';
    const bounds = win.getBoundingClientRect();
    assert(
      bounds.right <= innerWidth && bounds.bottom <= innerHeight,
      'Window stays within viewport',
    );
    win.style.width = original.width;
    win.style.height = original.height;
  });
  await test('renaming refreshes diagnostics and undo preserves window identity', async () => {
    const win = windows()[0]!;
    shell.editor.renameElement('button1', 'newButton');
    shell.redraw();
    await until(() =>
      win
        .querySelector('.script-problems')!
        .textContent!.includes('unknown name'),
    );
    assert(
      win.getAttribute('aria-label')!.includes('newButton'),
      'Window follows rename',
    );
    shell.editor.undo();
    shell.redraw();
    await until(
      () =>
        win.querySelector('.script-problems')!.textContent === '✓ No problems',
    );
    assert(
      win.getAttribute('aria-label')!.includes('button1'),
      'Window follows undo',
    );
    const view = viewOf(win);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '-- changed' },
    });
    shell.editor.undo();
    shell.redraw();
    assert(
      view.state.doc.toString() === source,
      'Global undo updates open editor',
    );
    shell.editor.redo();
    shell.redraw();
    assert(
      view.state.doc.toString() === '-- changed',
      'Global redo updates open editor',
    );
  });
  await test('Script edits autosave and survive portable export/import', async () => {
    await autosave.flush();
    const saved = await storage.loadProject(stored.id);
    assert(
      saved.project.pages[0]!.elements[0]!.script === '-- changed',
      'Autosaved Script',
    );
    const bytes = await writeProjectFile(shell.editor.project, new Map());
    const imported = await readProjectFile(bytes);
    assert(
      imported.project.pages[0]!.elements[0]!.script === '-- changed',
      'Element Script round trip',
    );
    assert(
      imported.project.pages[0]!.script === '-- Script 0' &&
        imported.project.script === '-- Script 1',
      'Page and Project round trip',
    );
  });
  await test('custom Handler edits refresh diagnostics without hiding name errors', async () => {
    const win = windows()[2]!;
    const view = viewOf(win);
    const original = view.state.doc.toString();
    const script =
      'on foundChart\n  put missingName into chart\nend foundChart\n';
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: script },
    });
    await until(() =>
      win
        .querySelector('.script-problems')!
        .textContent!.includes('unknown name'),
    );
    assert(
      !win
        .querySelector('.script-problems')!
        .textContent!.includes('does not declare'),
      'Custom message is declared after editing',
    );
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: script.replace('missingName', 'true'),
      },
    });
    await until(
      () =>
        win.querySelector('.script-problems')!.textContent === '✓ No problems',
    );
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: original },
    });
  });
  await test('live Info edits keep focus and undo as one step', async () => {
    shell.editor.click('button1');
    await until(() => !!document.querySelector('#info [data-field="label"]'));
    const label = document.querySelector<HTMLInputElement>(
      '#info [data-field="label"]',
    )!;
    const before = shell.editor.element('button1');
    label.focus();
    for (const value of ['G', 'Go']) {
      label.value = value;
      label.dispatchEvent(new Event('input', { bubbles: true }));
      assert(
        label.isConnected && document.activeElement === label,
        'Live input keeps its DOM and focus',
      );
      assert(
        shell.editor.element('button1')?.kind === 'button',
        'Owner remains a button',
      );
    }
    label.dispatchEvent(new Event('change', { bubbles: true }));
    shell.editor.undo();
    assert(
      shell.editor.element('button1') === before,
      'One undo restores the starting owner',
    );
  });
  await test('authored text keeps its editable DOM through immutable updates', () => {
    open('text1');
    const node = document.querySelector<HTMLElement>(
      '#page [data-element="text1"]',
    )!;
    node.focus();
    node.textContent = 'Edited text';
    node.dispatchEvent(new InputEvent('input', { bubbles: true }));
    assert(
      node.isConnected && document.activeElement === node,
      'Text editing retains its DOM and focus',
    );
    const element = shell.editor.element('text1');
    assert(
      element?.kind === 'text' &&
        element.richText[0]?.runs[0]?.text === 'Edited text',
      'Text reaches the frozen root',
    );
    node.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }),
    );
    assert(
      node.isConnected && node.textContent === 'Text',
      'Text undo retains the editable node',
    );
    node.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  await test('text gestures, close, read-only and Project replacement', () => {
    open('text1', true);
    assert(windows().length === 4, 'Shift-double-click opens text Script');
    windows().at(-1)!.querySelector<HTMLButtonElement>('.close')!.click();
    assert(windows().length === 3, 'Close destroys window');
    document.querySelector('#page [data-element="text1"]')!.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        metaKey: true,
        altKey: true,
      }),
    );
    assert(windows().length === 4, 'Command-option-click opens text Script');
    shell.setReadOnly(true);
    assert(
      windows().every(win => viewOf(win).state.readOnly),
      'All editors become read-only',
    );
    shell.editor.replaceProject(createProject('Next'));
    shell.redraw();
    assert(windows().length === 0, 'Switching Project closes stale editors');
  });
  await storage.deleteProject(stored.id);
  storage.close();
  return results;
};
