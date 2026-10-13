// Run on a dedicated page without main.js, as described in README.md.
import { EditorView } from '@codemirror/view';
import { createElement, createProject } from '../src/model';
import { mountStack } from '../src/stack';
import { mountPlay } from '../src/play-view';

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
  throw new Error('Timed out');
};
export const runBrowserTests = async () => {
  const project = createProject('Play browser check');
  const button = createElement('button', 'button1');
  button.script = 'on click\n set the label of me to "Clicked"\nend click';
  const input = createElement('text', 'input1');
  if (input.kind === 'text') {
    input.editable = true;
  }
  input.top = 110;
  input.script =
    'on textChanged\n set the label of button1 to the text of me\nend textChanged';
  project.pages[0]!.elements.push(button, input);
  const original = structuredClone(project);
  const shell = mountStack(project);
  mountPlay(shell);
  const toggle = document.querySelector<HTMLButtonElement>(
    '#menu [aria-pressed]',
  )!;
  const readerButton = () =>
    document.querySelector<HTMLElement>('#reader [data-element="button1"]')!;
  toggle.click();
  readerButton().click();
  await until(() => readerButton().textContent === 'Clicked');
  const field = document.querySelector<HTMLElement>(
    '#reader [data-element="input1"]',
  )!;
  field.focus();
  field.innerText = 'Reader input';
  field.blur();
  await until(() => readerButton().textContent === 'Reader input');
  assert(
    JSON.stringify(project) === JSON.stringify(original),
    'Play mutated authored data',
  );
  toggle.click();
  assert(!shell.readOnly, 'Edit remains locked');
  assert(
    document.querySelector('#page [data-element="button1"]')!.textContent ===
      'Button',
    'Edit did not restore label',
  );
  toggle.click();
  assert(readerButton().textContent === 'Button', 'New Play kept old state');
  toggle.click();
  button.script = 'on click\n repeat forever\n end repeat\nend click';
  toggle.click();
  readerButton().click();
  await new Promise(resolve => setTimeout(resolve, 10));
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert(
    [...document.querySelectorAll('#menu button')].some(
      b => b.textContent === 'Stopped',
    ),
    'Esc did not stop',
  );
  toggle.click();
  assert(!shell.readOnly, 'Runaway blocked Edit');
  button.script = 'on click\n put missing into x\nend click';
  toggle.click();
  const errorLink = [
    ...document.querySelectorAll<HTMLButtonElement>('.banner button'),
  ].find(b => b.textContent?.includes('unknown name'))!;
  assert(errorLink, 'Load error banner missing');
  errorLink.click();
  const view = EditorView.findFromDOM(
    document.querySelector('.script-window .cm-editor')!,
  )!;
  assert(
    view.state.doc.lineAt(view.state.selection.main.head).number === 2,
    'Error link did not select line',
  );
  assert(view.state.readOnly, 'Script editor allows authored changes in Play');
  shell.setReadOnly(true);
  toggle.click();
  assert(shell.readOnly, 'Returning to Edit lost external read-only state');
  return {
    passed: true,
    checks: [
      'visible property writes',
      'reader textChanged',
      'authored isolation',
      'fresh session',
      'Esc stops runaway',
      'return to Edit',
      'error link selects Script line',
      'read-only state preserved',
    ],
  };
};
