// Dedicated page without main.js; edits a Script in the Code Browser while
// browsing and Punches it In with ⌘↩ and the Edit menu (ADR 0157, #1897).
import { EditorView } from '@codemirror/view';
import { createElement, createPage, createProject } from '../src/model';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const until = async (check: () => boolean, message: string) => {
  for (let i = 0; i < 150; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
};

const labelled = (label: string) =>
  `on click {button: 0}\n  set the label of me to "${label}"\nend click`;

const project = createProject('Punch In');
const go = createElement('button', 'go');
go.script = labelled('old');
project.pages[0]!.elements.push(go);
const away = createPage('Away');
away.script = 'on openPage\nend openPage';
project.pages.push(away);
const shell = mountStack(project);
mountPlay(shell);

const mode = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('#tool-modes button')].find(
    b => b.textContent?.includes(label),
  )!;
const play = () =>
  document.querySelector<HTMLButtonElement>('#play-controls [data-play]')!;
const view = () =>
  EditorView.findFromDOM(
    document.querySelector<HTMLElement>('#code-browser .cm-editor')!,
  )!;
const replaceText = (text: string) => {
  const editor = view();
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
  });
};
// ⌘↩ on a Mac, Ctrl+Enter elsewhere, as CodeMirror reads Mod.
const pressPunchIn = () => {
  const mac = /Mac/u.test(navigator.platform);
  view().contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      metaKey: mac,
      ctrlKey: !mac,
    }),
  );
};
const note = () =>
  document.querySelector<HTMLElement>('#code-browser .punch-note')!;
const goNode = () =>
  document.querySelector<HTMLElement>('#reader [data-element="go"]')!;
const errorCount = () => document.querySelectorAll('#error-list li').length;

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

  await test('⌘↩ Punches In an edited Script while browsing', async () => {
    shell.openScript(shell.editor.project.pages[0]!.elements[0]!);
    await until(
      () => !!document.querySelector('#code-browser .cm-editor'),
      'No Code Browser',
    );
    play().click();
    await until(() => !!goNode(), 'Browse did not start');
    goNode().click();
    await until(
      () => goNode().textContent === 'old',
      'The old code did not run',
    );
    replaceText(labelled('new'));
    pressPunchIn();
    await until(
      () => note().textContent === 'Punched In.',
      `The note read “${note().textContent}”`,
    );
    goNode().click();
    await until(
      () => goNode().textContent === 'new',
      `The click ran the old code: ${goNode().textContent}`,
    );
  });

  await test('the Punched In edit is an ordinary authored edit', async () => {
    const script = shell.editor.project.pages[0]!.elements[0]!.script;
    assert(script === labelled('new'), `The Project held ${script}`);
    assert(shell.editor.canUndo, 'The edit cannot be undone');
  });

  await test('Edit → Punch In does the same, and a bad edit keeps the old code', async () => {
    const before = errorCount();
    replaceText(
      'on click {button: 0}\n  set the label of me to "bad"\nend nonsense',
    );
    const item = document.querySelector<HTMLButtonElement>(
      '#edit-menu [data-punch-in]',
    )!;
    assert(!item.disabled, 'Punch In was disabled while browsing');
    item.click();
    await until(
      () => errorCount() > before,
      'The failed load was not reported',
    );
    goNode().click();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert(
      goNode().textContent === 'new',
      `A failed load replaced the code: ${goNode().textContent}`,
    );
  });

  await test('a Script on another Page is only saved, and says so', async () => {
    shell.openScript(shell.editor.project.pages[1]!);
    await until(
      () => view().state.doc.toString().startsWith('on openPage'),
      'The Away Page Script did not open',
    );
    replaceText('on openPage\n  -- edited\nend openPage');
    pressPunchIn();
    await until(
      () => note().textContent?.startsWith('Saved.') ?? false,
      `The note read “${note().textContent}”`,
    );
    assert(
      shell.editor.project.pages[1]!.script?.includes('-- edited'),
      'The edit was not saved',
    );
  });

  await test('Punch In is off outside Browse', async () => {
    mode('Edit').click();
    await until(() => !goNode(), 'Browse did not end');
    const item = document.querySelector<HTMLButtonElement>(
      '#edit-menu [data-punch-in]',
    )!;
    assert(item.disabled, 'Punch In stayed enabled in Edit');
    assert(note().hidden, 'The Punch In note stayed after Play');
  });

  await test('⌘↩ in the Code Browser plays from Edit, typing nothing', async () => {
    const before = view().state.doc.toString();
    pressPunchIn();
    await until(() => !!goNode(), '⌘↩ did not start Play');
    assert(
      view().state.doc.toString() === before,
      'The key typed into the Script',
    );
    mode('Edit').click();
    await until(() => !goNode(), 'Play did not end');
  });

  return results;
};
