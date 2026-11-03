// Dedicated page: Perform's code pane (#2000). One Script at a time with
// recent ones as tabs, ⌥-click on the stage to open an Element's Script,
// ⌘↩ to Punch In, and errors over the code that never stop the show.
import { EditorView } from '@codemirror/view';
import { createElement, createProject } from '../src/model';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';
import { mountWindows } from '../src/windows';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 150; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

// Each click counts, so a click that ran is seen even when the label holds.
const labelled = (label: string) =>
  `script variable n = 0\non click {button: 0}\n  add 1 to n\n  set the label of me to "${label} " & n\nend click`;
const project = createProject('Perform code');
project.play = 'perform';
const go = { ...createElement('button', 'go'), left: 20, top: 20 };
go.script = labelled('old');
const boom = { ...createElement('button', 'boom'), left: 20, top: 80 };
boom.script = 'on click {button: 0}\n  put 1 / 0 into x\nend click';
project.pages[0]!.elements.push(go, boom);
const shell = mountStack(project);
mountWindows();
mountPlay(shell);

const perform = () =>
  document.querySelector<HTMLButtonElement>('#play-controls [data-play]')!;
const stage = (name: string) =>
  document.querySelector<HTMLElement>(
    `#perform #reader [data-element="${name}"]`,
  )!;
const tabs = () =>
  [...document.querySelectorAll<HTMLElement>('#perform [role="tab"]')].map(
    t =>
      `${t.getAttribute('aria-selected') === 'true' ? '*' : ''}${t.textContent}`,
  );
const banner = () => document.querySelector<HTMLElement>('.perform-error')!;
const view = () =>
  EditorView.findFromDOM(
    document.querySelector<HTMLElement>('#code-browser .cm-editor')!,
  )!;
const replaceText = (text: string) =>
  view().dispatch({
    changes: { from: 0, to: view().state.doc.length, insert: text },
  });
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

  perform().click();
  await until(() => !!stage('go'), 'Perform');

  await test('⌥-click opens an Element’s Script as a tab, without clicking it', async () => {
    stage('go').dispatchEvent(
      new MouseEvent('click', { bubbles: true, altKey: true, detail: 1 }),
    );
    await until(() => tabs().includes('*Script of Element “go”'), 'go’s tab');
    stage('boom').dispatchEvent(
      new MouseEvent('click', { bubbles: true, altKey: true, detail: 1 }),
    );
    await until(
      () => tabs().at(-1) === '*Script of Element “boom”',
      'boom’s tab',
    );
    assert(
      !stage('go').textContent?.startsWith('old'),
      'the ⌥-click did not run go',
    );
    assert(
      getComputedStyle(
        document.querySelector('#code-browser .code-browser-columns')!,
      ).display === 'none',
      'one Script at a time: the columns are hidden',
    );
    const all = document.querySelectorAll<HTMLElement>('#perform [role="tab"]');
    all[tabs().indexOf('Script of Element “go”')]!.click();
    await until(
      () => view().state.doc.toString() === go.script,
      'the tab showing go’s Script',
    );
  });

  await test('⌘↩ Punches In while performing', async () => {
    replaceText(labelled('new'));
    pressPunchIn();
    await new Promise(resolve => setTimeout(resolve, 100));
    stage('go').click();
    await until(() => stage('go').textContent === 'new 1', 'the new Script');
  });

  await test('a Punch In that fails to compile keeps the last good one playing', async () => {
    replaceText('on click {button: 0}\n  set the label of me to\nend click');
    pressPunchIn();
    await until(() => !banner().hidden, 'the error banner');
    assert(
      document.getElementById('errors-window')?.offsetParent === null,
      'the Errors window stays hidden',
    );
    stage('go').click();
    await until(
      () => stage('go').textContent === 'new 2',
      'the last good Script',
    );
    replaceText(labelled('fixed'));
    pressPunchIn();
    await until(
      () => banner().hidden === true,
      'a good Punch In to clear the banner',
    );
  });

  await test('a runtime error shows over the code and the show goes on', async () => {
    stage('boom').click();
    await until(() => !banner().hidden, 'the runtime error');
    stage('go').click();
    await until(
      () => stage('go').textContent?.startsWith('fixed') === true,
      'go still playing',
    );
  });

  perform().click();
  return results;
};
