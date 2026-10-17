// Run on a dedicated page without main.js, as described in README.md.
import { EditorView } from '@codemirror/view';
import { createElement, createPage, createProject } from '../src/model';
import { mountStack } from '../src/stack';
import { MESSAGE_FIRST_LINE } from '../src/message-script';
import { mountPlay } from '../src/play-view';
import {
  readRichText,
  selectTextRange,
  selectionInText,
} from '../src/rich-text-dom';

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
    input.richText = [
      { runs: [{ text: 'Authored journal', italic: true, color: '#123456' }] },
    ];
  }
  input.top = 110;
  input.script =
    'on textChanged\n set the label of button1 to the text of me\nend textChanged';
  project.pages[0]!.elements.push(button, input);
  const original = structuredClone(project);
  const shell = mountStack(project);
  mountPlay(shell);
  const authoredRichText = JSON.stringify(
    readRichText(
      document.querySelector<HTMLElement>('#page [data-element="input1"]')!,
    ),
  );
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
  field.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await until(() => readerButton().textContent === 'Reader input');
  const toolbar = document.querySelector<HTMLElement>('#play-text-toolbar')!;
  const command = (name: string) =>
    toolbar
      .querySelector<HTMLButtonElement>(`[data-text-command="${name}"]`)!
      .click();
  assert(!toolbar.hidden, 'Reader toolbar missing');
  assert(
    field.getAttribute('role') === 'textbox',
    'Reader text is not accessible',
  );
  selectTextRange(field, { start: 0, end: 6 });
  for (const mark of ['bold', 'italic', 'underline']) {
    command(mark);
    assert(
      readRichText(field)[0]!.runs[0]![mark as 'bold' | 'italic' | 'underline'],
      `Reader ${mark} missing`,
    );
  }
  const color = toolbar.querySelector<HTMLInputElement>('input[type="color"]')!;
  color.focus();
  assert(!toolbar.hidden, 'Colour focus closed reader editing');
  color.value = '#ff0000';
  color.dispatchEvent(new Event('input', { bubbles: true }));
  await until(() => readerButton().textContent === 'Reader input');
  assert(
    readRichText(field)[0]!.runs[0]!.color === 'rgb(255, 0, 0)',
    'Reader colour missing',
  );
  assert(selectionInText(field)?.end === 6, 'Script redraw lost selection');
  const formatted = JSON.stringify(readRichText(field));
  command('undo');
  assert(!readRichText(field)[0]!.runs[0]!.color, 'Reader undo failed');
  command('redo');
  assert(
    JSON.stringify(readRichText(field)) === formatted,
    'Reader redo failed',
  );
  command('done');
  assert(
    toolbar.hidden && field.contentEditable === 'true',
    'Done disabled later editing',
  );
  field.focus();
  assert(!toolbar.hidden, 'Reader cannot reopen editing');
  const paste = new DataTransfer();
  paste.setData(
    'text/html',
    '<p><b>Clue</b> <a href="https://example.com">one</a><img src="bad"><script>bad()</script></p><p><u>Journal</u></p>',
  );
  selectTextRange(field, { start: 0, end: 12 });
  field.dispatchEvent(
    new ClipboardEvent('paste', {
      clipboardData: paste,
      bubbles: true,
      cancelable: true,
    }),
  );
  await until(() => readerButton().textContent === 'Clue one\nJournal');
  assert(
    !field.querySelector('a,img,script'),
    'Reader paste kept unsupported HTML',
  );
  assert(
    readRichText(field)[1]!.runs[0]!.underline,
    'Reader paste lost formatting',
  );
  field.dispatchEvent(
    new InputEvent('beforeinput', {
      inputType: 'insertParagraph',
      cancelable: true,
    }),
  );
  await until(() => readerButton().textContent === 'Clue one\nJournal\n');
  command('undo');
  await until(() => readerButton().textContent === 'Clue one\nJournal');
  field.dispatchEvent(new CompositionEvent('compositionstart'));
  field.querySelector('span')!.textContent = '日本語';
  field.dispatchEvent(new InputEvent('input', { isComposing: true }));
  assert(
    readerButton().textContent === 'Clue one\nJournal',
    'IME committed before composition ended',
  );
  readerButton().click();
  await until(() => readerButton().textContent === 'Clicked');
  assert(
    field.querySelector('span')!.textContent === '日本語',
    'Unrelated Script redraw interrupted IME',
  );
  field.dispatchEvent(new CompositionEvent('compositionend'));
  await until(() => readerButton().textContent === '日本語 one\nJournal');
  assert(
    JSON.stringify(project) === JSON.stringify(original),
    'Play mutated authored data',
  );
  toggle.click();
  assert(!shell.readOnly, 'Edit remains locked');
  assert(toolbar.hidden, 'Reader toolbar visible in Edit');
  assert(
    JSON.stringify(
      readRichText(
        document.querySelector<HTMLElement>('#page [data-element="input1"]')!,
      ),
    ) === authoredRichText,
    'Edit did not restore authored text and formatting',
  );
  assert(
    document.querySelector('#page [data-element="button1"]')!.textContent ===
      'Button',
    'Edit did not restore label',
  );
  toggle.click();
  assert(readerButton().textContent === 'Button', 'New Play kept old state');
  assert(
    document.querySelector('#reader [data-element="input1"]')!.textContent ===
      'Authored journal',
    'New Play kept reader text',
  );
  toggle.click();
  button.script =
    'on click\n set the text of input1 to "Authored journal"\nend click';
  toggle.click();
  const replaced = document.querySelector<HTMLElement>(
    '#reader [data-element="input1"]',
  )!;
  replaced.focus();
  selectTextRange(replaced, { start: 0, end: 8 });
  command('bold');
  readerButton().click();
  await until(
    () => !replaced.querySelector('[style*="bold"], [style*="italic"]'),
  );
  assert(
    replaced === document.activeElement,
    'Script text replacement lost reader focus',
  );
  assert(
    toolbar.querySelector<HTMLButtonElement>('[data-text-command="undo"]')!
      .disabled,
    'Script replacement kept stale reader undo',
  );
  toggle.click();
  const second = createPage('page2');
  const back = createElement('button', 'button1');
  back.script = 'on click\n tell pages to show page1\nend click';
  second.elements.push(back);
  project.pages.push(second);
  button.script =
    'on click\n set the label of me to "Kept"\n tell pages to show page2\nend click';
  input.script = '';
  toggle.click();
  const journal = document.querySelector<HTMLElement>(
    '#reader [data-element="input1"]',
  )!;
  journal.focus();
  journal.innerText = 'Kept journal';
  journal.dispatchEvent(new InputEvent('input'));
  selectTextRange(journal, { start: 0, end: 4 });
  command('bold');
  const keptRichText = JSON.stringify(readRichText(journal));
  assert(
    getComputedStyle(document.querySelector('#strip')!).display === 'none',
    'Pages strip visible in Play',
  );
  readerButton().click();
  await until(() => !document.querySelector('#reader [data-element="input1"]'));
  assert(toolbar.hidden, 'Navigation kept departed text toolbar');
  readerButton().click();
  await until(
    () => !!document.querySelector('#reader [data-element="input1"]'),
  );
  assert(
    readerButton().textContent === 'Kept',
    'Revisit lost visual state or reused the wrong click listener',
  );
  assert(
    JSON.stringify(
      readRichText(
        document.querySelector<HTMLElement>('#reader [data-element="input1"]')!,
      ),
    ) === keptRichText,
    'Navigation lost reader text or formatting',
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
  for (const action of ['Stop', 'Escape']) {
    toggle.click();
    readerButton().click();
    await until(() => readerButton().textContent === 'Waiting');
    if (action === 'Escape') {
      const editing = document.querySelector<HTMLElement>(
        '#reader [data-element="input1"]',
      )!;
      editing.focus();
      editing.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    } else {
      document
        .querySelector<HTMLElement>('#reader [data-element="input1"]')!
        .focus();
      assert(toggle.textContent === 'Stop', 'Play button is not Stop');
      toggle.click();
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    assert(toolbar.hidden, `${action} left reader formatting active`);
    assert(!shell.readOnly, `Wait blocked ${action} returning to Edit`);
    assert(
      document.querySelector<HTMLElement>('#reader')!.hidden,
      `${action} left Play visible`,
    );
    assert(toggle.textContent === 'Present', `${action} left the Stop button`);
    assert(
      document.querySelector('#page [data-element="button1"]')!.textContent ===
        'Button',
      `${action} let a wait change Edit`,
    );
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
    document.querySelector<HTMLElement>('#reader')!.hidden,
    'Esc did not stop',
  );
  assert(!shell.readOnly, 'Runaway blocked Edit');
  button.script = 'on click\n put missing into x\nend click';
  toggle.click();
  const errorLink = [
    ...document.querySelectorAll<HTMLButtonElement>('#error-list button'),
  ].find(b => b.textContent?.includes('unknown name'))!;
  assert(errorLink, 'Load error missing from the Errors window');
  errorLink.click();
  const view = EditorView.findFromDOM(
    document.querySelector('.script-window .cm-editor')!,
  )!;
  assert(
    view.state.doc.lineAt(view.state.selection.main.head).number === 2,
    'Error link did not select line',
  );
  assert(view.state.readOnly, 'Script editor allows authored changes in Play');
  toggle.click();
  assert(
    document.querySelectorAll('#error-list li').length === 1 &&
      !document.querySelector<HTMLElement>('#errors-window')!.hidden,
    'Stop discarded the Errors window',
  );

  // Browsing plays in place beside the windows; Scripts stay editable and
  // apply to the next session.
  const mode = (name: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>('#tool-modes button'),
    ].find(b => b.textContent?.includes(name))!;
  mode('Browse').click();
  assert(
    document.body.classList.contains('browsing') &&
      document.querySelector('#desk #reader') &&
      getComputedStyle(document.querySelector('#tools-window')!).display !==
        'none',
    'Browse did not play in place',
  );
  assert(
    document.querySelectorAll('#error-list li').length === 1,
    'Browse did not start with fresh errors',
  );
  assert(!view.state.readOnly, 'Script editor read-only while browsing');
  button.script = 'on click\n set the label of me to "Fixed"\nend click';
  readerButton().click();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert(
    readerButton().textContent !== 'Fixed',
    'A Script edit changed the running session',
  );
  document
    .querySelector('#reader')!
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  assert(
    !document.body.classList.contains('browsing') &&
      document.querySelector<HTMLElement>('#reader')!.hidden,
    'Esc did not leave Browse',
  );
  mode('Browse').click();
  assert(
    !document.querySelectorAll('#error-list li').length,
    'Fixed Script still reported',
  );
  readerButton().click();
  await until(() => readerButton().textContent === 'Fixed');
  document
    .querySelector<HTMLButtonElement>('#tools [data-kind="text"]')!
    .click();
  assert(
    !document.body.classList.contains('browsing') &&
      project.pages[0]!.elements.length > 2,
    'An Element tool did not return to Edit and add',
  );
  shell.editor.undo();
  shell.redraw();
  shell.setReadOnly(true);
  toggle.click();
  assert(shell.readOnly, 'Returning to Edit lost external read-only state');
  return {
    passed: true,
    checks: [
      'navigation, same-named Elements, retained visuals and hidden strip',
      'visible property writes',
      'reader textChanged',
      'reader rich text, selection colour, undo/redo, paste, paragraphs and IME',
      'reader formatting retained across navigation and restored exactly in Edit',
      'authored isolation',
      'fresh session',
      'wait resumes visibly without blocking reader input or other Scripts',
      'navigation cancels Page and Element waits while Project waits continue',
      'Stop and Esc cancel waits and return to Edit without late effects',
      'Esc stops runaway and returns to Edit',
      'Errors window links to the Script line and outlasts Stop',
      'Browse plays in place, with Scripts editable for the next session',
      'Esc and Element tools return from Browse to Edit',
      'read-only state preserved',
    ],
  };
};

export const runElementsBrowserTests = async () => {
  const project = createProject('Dynamic Elements');
  const button = createElement('button', 'original');
  button.script = 'on click\n tell elements to delete me\nend click';
  project.pages[0]!.elements.push(button);
  project.pages[0]!.script = `on openPage
 ask elements to create "button", thisPage, "made"
 set the label of it to "Created"
 ask elements to clone original
end openPage
on click
 ask elements to find "made", thisPage
 tell elements to delete it
 ask elements to create "button", thisPage, "made"
 set the label of it to "Replacement"
end click`;
  const before = structuredClone(project);
  const shell = mountStack(project);
  mountPlay(shell);
  const toggle = document.querySelector<HTMLButtonElement>(
    '#menu [aria-pressed]',
  )!;
  const element = (name: string) =>
    document.querySelector<HTMLElement>(`#reader [data-element="${name}"]`);
  toggle.click();
  await until(
    () => !!element('original2') && element('made')?.textContent === 'Created',
  );
  element('original2')!.click();
  await until(() => !element('original2'));
  assert(element('original'), 'Deleting clone removed original');
  element('made')!.click();
  await until(() => element('made')?.textContent === 'Replacement');
  // Reusing a name must bind the DOM listeners to the new Element handle.
  const firstReplacement = element('made');
  element('made')!.click();
  await until(
    () =>
      element('made') !== firstReplacement &&
      element('made')?.textContent === 'Replacement',
  );
  element('original')!.click();
  await until(() => !element('original'));
  toggle.click();
  assert(
    JSON.stringify(project) === JSON.stringify(before),
    'Dynamic Elements changed authored Project',
  );
  assert(
    !document.querySelector('#page [data-element="made"]'),
    'Created Element survived Edit',
  );
  assert(
    document.querySelector('#page [data-element="original"]'),
    'Authored Element missing in Edit',
  );
  return {
    passed: true,
    checks: [
      'create and Page handler',
      'clone Script and delete',
      'reuse deleted name',
      'exact Edit restore',
    ],
  };
};

export const runFrameBrowserTests = async () => {
  const project = createProject('Frames');
  const button = createElement('button', 'counter');
  project.pages[0]!.elements.push(button);
  project.pages[0]!.script = `script variable frames = 0
on frame elapsed
 add 1 to frames
 set the label of counter to "" & frames
end frame`;
  const shell = mountStack(project);
  mountPlay(shell);
  const toggle = document.querySelector<HTMLButtonElement>(
    '#menu [aria-pressed]',
  )!;
  const counter = () =>
    Number(
      document.querySelector('#reader [data-element="counter"]')?.textContent,
    );
  toggle.click();
  await until(() => counter() >= 10);
  toggle.click();
  const stopped = document.querySelector(
    '#page [data-element="counter"]',
  )?.textContent;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert(
    document.querySelector('#page [data-element="counter"]')?.textContent ===
      stopped,
    'Frames continued in Edit',
  );
  return {
    passed: true,
    checks: ['frames reach a Page Script', 'no frames in Edit'],
  };
};

export const runKeyBrowserTests = async () => {
  const project = createProject('Keys');
  const button = createElement('button', 'last');
  project.pages[0]!.elements.push(button);
  const shell = mountStack(project);
  mountPlay(shell);
  const toggle = document.querySelector<HTMLButtonElement>(
    '#menu [aria-pressed]',
  )!;
  const reader = document.querySelector<HTMLElement>('#reader')!;
  const press = () => {
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    reader.dispatchEvent(event);
    return event.defaultPrevented;
  };
  toggle.click();
  assert(!press(), 'An unhandled arrow key was claimed');
  toggle.click();
  project.pages[0]!.script =
    'on keyDown key\n set the label of last to key\nend keyDown';
  toggle.click();
  assert(press(), 'A handled arrow key still scrolls');
  await until(
    () =>
      document.querySelector('#reader [data-element="last"]')?.textContent ===
      'ArrowDown',
  );
  toggle.click();
  // Space on a focused button clicks it without also reaching the Page.
  project.pages[0]!.script =
    'on keyDown key\n set the label of last to "key " & key\nend keyDown';
  button.script = 'on click\n set the label of me to "clicked"\nend click';
  toggle.click();
  const last = () =>
    document.querySelector<HTMLElement>('#reader [data-element="last"]')!;
  last().focus();
  last().dispatchEvent(
    new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
  );
  await until(() => last().textContent === 'clicked');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert(last().textContent === 'clicked', 'Space on a button sent keyDown');
  // A pointer click leaves focus with the Page, so Space reaches it.
  last().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  assert(document.activeElement === reader, 'A pointer click kept focus');
  toggle.click();
  return {
    passed: true,
    checks: [
      'unhandled keys keep their default',
      'handled keys are claimed',
      'Space on a focused button only clicks',
      'a pointer click returns focus to the Page',
    ],
  };
};

export const runUserBrowserTests = async () => {
  const project = createProject('User prompts');
  const button = createElement('button', 'button1');
  button.script = `on click
 ask user to confirm "Carry on?" and wait
 put it into carry
 ask user to choose ["Red", "Blue"], {prompt: "Colour"} and wait
 put it into colour
 ask user to enter "Name", {default: "Ada"} and wait
 set the label of me to carry & " " & colour & " " & it
 tell user to notify "Saved", {title: "Folio"}
end click`;
  const waiter = createElement('button', 'waiter');
  waiter.top = 110;
  waiter.script =
    'on click\n ask user to confirm "Pending?" and wait\n set the label of me to "Late"\nend click';
  project.pages[0]!.elements.push(button, waiter);
  const shell = mountStack(project);
  mountPlay(shell);
  const toggle = document.querySelector<HTMLButtonElement>(
    '#menu [aria-pressed]',
  )!;
  const element = (name: string) =>
    document.querySelector<HTMLElement>(`#reader [data-element="${name}"]`)!;
  const dialog = () =>
    document.querySelector<HTMLFormElement>('#reader .play-prompt');
  const title = () => dialog()?.querySelector('p')?.textContent;
  toggle.click();
  element('button1').click();
  await until(() => title() === 'Carry on?');
  assert(
    dialog()!.contains(document.activeElement),
    'Prompt did not take focus',
  );
  dialog()!.requestSubmit();
  await until(() => title() === 'Colour');
  dialog()!.querySelectorAll<HTMLInputElement>('input')[1]!.click();
  dialog()!.requestSubmit();
  await until(() => title() === 'Name');
  const field = dialog()!.querySelector<HTMLInputElement>('input')!;
  assert(field.value === 'Ada', 'enter default missing');
  field.value = 'Grace';
  dialog()!.requestSubmit();
  await until(() => element('button1').textContent === 'true Blue Grace');
  await until(() =>
    Boolean(
      document.querySelector('#reader .play-notice')?.textContent ===
      'FolioSaved',
    ),
  );
  // Escape in a prompt answers it rather than leaving Play.
  element('button1').click();
  await until(() => title() === 'Carry on?');
  dialog()!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await until(() => title() === 'Colour');
  assert(toggle.getAttribute('aria-pressed') === 'true', 'Escape left Play');
  dialog()!.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
  await until(() => title() === 'Name');
  dialog()!.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
  await until(() => !dialog());
  // Stop takes a pending prompt down.
  element('waiter').click();
  await until(() => title() === 'Pending?');
  toggle.click();
  assert(!dialog(), 'Prompt survived Stop');
  return {
    passed: true,
    checks: [
      'confirm, choose and enter answers',
      'notice with title',
      'Escape and Cancel dismiss',
      'Stop takes the prompt down',
    ],
  };
};

export const runMessageBoxBrowserTests = async () => {
  const project = createProject('Message Box');
  const welcome = createElement('text', 'welcomeText');
  project.pages[0]!.elements.push(welcome);
  const shell = mountStack(project);
  mountPlay(shell);
  document.querySelector<HTMLButtonElement>('#show-message')!.click();
  const win = document.querySelector<HTMLElement>('#message-window')!;
  assert(win && !win.hidden, 'Message Box did not open');
  assert(
    win.classList.contains('code-window') &&
      getComputedStyle(win).resize === 'both',
    'Message Box is not a resizable code window',
  );
  const view = EditorView.findFromDOM(win.querySelector('.cm-editor')!)!;
  const log = () =>
    [...win.querySelectorAll('.message-log li')].map(li => li.textContent);
  const type = (text: string) =>
    view.dispatch({
      changes: { from: view.state.selection.main.head, insert: text },
    });
  const enter = () =>
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  assert(view.contentDOM.innerText.trim() === '', 'Wrapper lines are visible');

  // Ctrl-Space completes the Page's names from the language server.
  type('hide wel');
  assert(
    view.state.doc.toString().includes('hide wel'),
    `Typing was refused at ${view.state.selection.main.head} in ${JSON.stringify(view.state.doc.toString())}`,
  );
  // Ask once the language server has the document, then wait for the list.
  await new Promise(resolve => setTimeout(resolve, 300));
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      ctrlKey: true,
      bubbles: true,
    }),
  );
  await until(() =>
    [...document.querySelectorAll('.cm-tooltip-autocomplete li')].some(li =>
      li.textContent?.includes('welcomeText'),
    ),
  );

  // The wrapper cannot be edited away.
  view.dispatch({ changes: { from: 0, to: view.state.doc.length } });
  assert(
    view.state.doc.toString().includes('on runMessage'),
    'Typing removed the hidden wrapper',
  );

  // In Edit, `hide` changes the authored Element as one undoable edit.
  view.dispatch({
    changes: {
      from: view.state.selection.main.head,
      to: view.state.selection.main.head,
    },
  });
  const { from, to } = (() => {
    const doc = view.state.doc;
    return {
      from: doc.line(MESSAGE_FIRST_LINE).from,
      to: doc.line(doc.lines).from - 1,
    };
  })();
  view.dispatch({
    changes: { from, to, insert: 'hide welcomeText' },
    selection: { anchor: from + 'hide welcomeText'.length },
  });
  // Close completion so Enter runs.
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  enter();
  await until(() => !welcome.visible);
  assert(shell.editor.canUndo, 'hide was not undoable');

  // While browsing, `show` changes only the session.
  document.querySelector<HTMLButtonElement>('#tool-modes button')!.click();
  const set = (text: string) => {
    const doc = view.state.doc;
    const range = {
      from: doc.line(MESSAGE_FIRST_LINE).from,
      to: doc.line(doc.lines).from - 1,
    };
    view.dispatch({
      changes: { ...range, insert: text },
      selection: { anchor: range.from + text.length },
    });
  };
  set('show welcomeText');
  enter();
  await until(
    () =>
      document.querySelector<HTMLElement>(
        '#reader [data-element="welcomeText"]',
      )?.hidden === false,
  );
  assert(!welcome.visible, 'Browsing changed the authored Element');
  set('the visible of welcomeText');
  enter();
  await until(() => log().at(-1) === 'true');
  // Every window shares the title bar, and the Window menu shows and hides
  // them, with a tick for each one showing.
  document
    .querySelector<HTMLButtonElement>('#tool-modes button:last-child')!
    .click();
  const item = (id: string) =>
    document.querySelector<HTMLButtonElement>(
      `#window-menu [data-window="${id}"]`,
    )!;
  const showing = (id: string) => !document.getElementById(id)!.hidden;
  const menu = document.querySelector<HTMLDetailsElement>('#window-menu')!;
  for (const id of ['tools-window', 'info-window', 'message-window']) {
    const close = document.querySelector<HTMLButtonElement>(
      `#${id} > .bar > .close`,
    );
    assert(close, `${id} has no close box`);
    close!.click();
    assert(!showing(id), `${id} close box did not hide it`);
    menu.open = true;
    menu.dispatchEvent(new Event('toggle'));
    assert(
      item(id).getAttribute('aria-checked') === 'false',
      `${id} still ticked`,
    );
    item(id).click();
    assert(showing(id), `Window menu did not show ${id}`);
    assert(
      item(id).getAttribute('aria-checked') === 'true',
      `${id} not ticked`,
    );
  }
  item('info-window').click();
  assert(
    JSON.parse(
      localStorage.getItem('northtalk-creative-closed-windows') ?? '[]',
    ).includes('info-window'),
    'Closing Info was not remembered',
  );
  item('info-window').click();
  // Info resizes like the code windows, its fields filling the height.
  const info = document.querySelector<HTMLElement>('#info-window')!;
  const fields = document.querySelector<HTMLElement>('#info')!;
  assert(getComputedStyle(info).resize === 'both', 'Info is not resizable');
  info.style.height = '200px';
  await new Promise(requestAnimationFrame);
  const short = fields.clientHeight;
  info.style.height = '400px';
  await new Promise(requestAnimationFrame);
  assert(
    fields.clientHeight > short + 150,
    'Info fields do not fill the window',
  );
  info.style.height = '';
  // Window menu items read left to right from the tick.
  const label = item('tools-window');
  assert(
    getComputedStyle(label).justifyContent === 'flex-start',
    'Window menu items are not left-aligned',
  );
  return {
    passed: true,
    checks: [
      'Info resizes and its fields fill it; Window menu items are left-aligned',
      'Tools, Info and Message Box close from their title bars and reopen from the Window menu, ticked when showing; closed Tools and Info are remembered',
      'resizable code window with hidden, protected wrapper lines',
      'Ctrl-Space completes Page names from the language server',
      'hide in Edit is one undoable authored edit',
      'show while browsing changes only the session; expressions print',
    ],
  };
};
