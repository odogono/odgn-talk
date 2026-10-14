// Run on a dedicated page without main.js, as described in README.md.
import { EditorView } from '@codemirror/view';
import { createElement, createPage, createProject } from '../src/model';
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
  const second = createPage('page2');
  const back = createElement('button', 'button1');
  back.script = 'on click\n tell pages to show page1\nend click';
  second.elements.push(back);
  project.pages.push(second);
  button.script =
    'on click\n set the label of me to "Kept"\n tell pages to show page2\nend click';
  toggle.click();
  assert(
    getComputedStyle(document.querySelector('#strip')!).display === 'none',
    'Pages strip visible in Play',
  );
  readerButton().click();
  await until(() => !document.querySelector('#reader [data-element="input1"]'));
  readerButton().click();
  await until(
    () => !!document.querySelector('#reader [data-element="input1"]'),
  );
  assert(
    readerButton().textContent === 'Kept',
    'Revisit lost visual state or reused the wrong click listener',
  );
  toggle.click();
  button.script =
    'on click\n set the label of me to "Waiting"\n wait 200 ms\n set the label of me to "Finished"\nend click';
  input.script =
    'on pointerEnter\n set the text of me to "Responsive"\nend pointerEnter';
  toggle.click();
  readerButton().click();
  await until(() => readerButton().textContent === 'Waiting');
  document
    .querySelector('#reader [data-element="input1"]')!
    .dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
  await until(
    () =>
      document.querySelector('#reader [data-element="input1"]')!.textContent ===
      'Responsive',
  );
  assert(
    readerButton().textContent === 'Waiting',
    'Wait blocked other Scripts',
  );
  await until(() => readerButton().textContent === 'Finished');
  toggle.click();

  // The Page and Element Runs must be cancelled, while the Project Run lives.
  project.script =
    'on startPlay\n wait 400 ms\n set the background of page2 to "rgb(1, 2, 3)"\nend startPlay\non leaked\n set the height of page2 to 999\nend leaked';
  project.pages[0]!.script =
    'on openPage\n wait 200 ms\n send leaked to project\nend openPage';
  button.script =
    'on click\n set the label of me to "Waiting"\n wait 200 ms\n set the label of me to "Late"\n send leaked to project\nend click';
  input.script = 'on click\n tell pages to show page2\nend click';
  toggle.click();
  readerButton().click();
  await until(() => readerButton().textContent === 'Waiting');
  document
    .querySelector<HTMLElement>('#reader [data-element="input1"]')!
    .click();
  await until(() => !document.querySelector('#reader [data-element="input1"]'));
  await until(
    () =>
      document.querySelector<HTMLElement>('#reader .page')!.style.background ===
      'rgb(1, 2, 3)',
  );
  assert(
    document.querySelector<HTMLElement>('#reader .page')!.style.height !==
      '999px',
    'Departed Page or Element wait sent a late message',
  );
  readerButton().click();
  await until(
    () => !!document.querySelector('#reader [data-element="input1"]'),
  );
  assert(readerButton().textContent === 'Waiting', 'Departed Element wait ran');
  toggle.click();

  project.script =
    'on startPlay\n wait 200 ms\n set the height of page1 to 999\nend startPlay';
  project.pages[0]!.script =
    'on openPage\n wait 200 ms\n set the background of me to "rgb(1, 2, 3)"\nend openPage';
  button.script =
    'on click\n set the label of me to "Waiting"\n wait 200 ms\n set the label of me to "Late"\nend click';
  const waitingOriginal = structuredClone(project);
  for (const action of ['Stop', 'Escape', 'Edit']) {
    toggle.click();
    readerButton().click();
    await until(() => readerButton().textContent === 'Waiting');
    if (action === 'Edit') {
      toggle.click();
    } else if (action === 'Escape') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    } else {
      [...document.querySelectorAll<HTMLButtonElement>('#menu button')]
        .find(b => b.textContent === 'Stop')!
        .click();
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    if (action === 'Edit') {
      assert(!shell.readOnly, 'Wait blocked return to Edit');
      assert(
        document.querySelector<HTMLElement>('#reader')!.hidden,
        'Play visible',
      );
      assert(
        document.querySelector('#page [data-element="button1"]')!
          .textContent === 'Button',
        'Wait changed Edit after returning',
      );
    } else {
      assert(
        readerButton().textContent === 'Waiting',
        `${action} leaked Element wait`,
      );
      const page = document.querySelector<HTMLElement>('#reader .page')!;
      assert(page.style.height !== '999px', `${action} leaked Project wait`);
      assert(
        page.style.background !== 'rgb(1, 2, 3)',
        `${action} leaked Page wait`,
      );
      toggle.click();
    }
    assert(
      JSON.stringify(project) === JSON.stringify(waitingOriginal),
      `${action} allowed a wait to change authored data`,
    );
  }
  project.script = '';
  project.pages[0]!.script = '';
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
      'navigation, same-named Elements, retained visuals and hidden strip',
      'visible property writes',
      'reader textChanged',
      'authored isolation',
      'fresh session',
      'wait resumes visibly without blocking reader input or other Scripts',
      'navigation cancels Page and Element waits while Project waits continue',
      'Stop, Esc and Back to Edit cancel waits without late effects',
      'Esc stops runaway',
      'return to Edit',
      'error link selects Script line',
      'read-only state preserved',
    ],
  };
};
