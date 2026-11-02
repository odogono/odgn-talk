// Dedicated page: Perform's toolbar (#2002). Hush and ⌘⇧. silence while
// Play goes on, Revert puts back the Script Play loaded, and the tempo and
// bar show live.
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
  for (let i = 0; i < 250; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

// The requests the page sends the worker, to see Hush go.
const requests: string[] = [];
const post = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (
  this: Worker,
  message: unknown,
  ...rest: never[]
) {
  const kind = (message as { request?: { kind?: string } })?.request?.kind;
  if (kind) {
    requests.push(kind);
  }
  return post.call(this, message, ...rest);
} as never;

const original =
  'on click {button: 0}\n  set the label of me to "went"\nend click';
const project = createProject('Perform toolbar');
const go = { ...createElement('button', 'go'), left: 20, top: 20 };
go.script = original;
project.pages[0]!.elements.push(go);
const shell = mountStack(project);
mountWindows();
mountPlay(shell);

const perform = () =>
  document.querySelector<HTMLButtonElement>('#play-controls [data-perform]')!;
const stage = (name: string) =>
  document.querySelector<HTMLElement>(
    `#perform #reader [data-element="${name}"]`,
  )!;
const clock = () =>
  document.querySelector<HTMLElement>('#perform .perform-clock')!.textContent ??
  '';
const view = () =>
  EditorView.findFromDOM(
    document.querySelector<HTMLElement>('#code-browser .cm-editor')!,
  )!;

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

  await test('the toolbar shows the tempo and the bar as it moves', async () => {
    await until(() => /^120 BPM · bar \d+\.\d$/u.test(clock()), 'the bar');
    const first = clock();
    await until(() => clock() !== first, 'the beat to move on');
  });

  await test('Hush and ⌘⇧. silence, and Play goes on', async () => {
    document.querySelector<HTMLButtonElement>('#perform [data-hush]')!.click();
    await until(() => requests.includes('hush'), 'Hush to reach the worker');
    const count = requests.filter(r => r === 'hush').length;
    view().contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: '>',
        code: 'Period',
        shiftKey: true,
        metaKey: true,
      }),
    );
    await until(
      () => requests.filter(r => r === 'hush').length === count + 1,
      '⌘⇧. to Hush from the code',
    );
    stage('go').click();
    await until(() => stage('go').textContent === 'went', 'Play going on');
  });

  await test('Revert puts back the Script as Play loaded it', async () => {
    stage('go').dispatchEvent(
      new MouseEvent('click', { bubbles: true, altKey: true, detail: 1 }),
    );
    await until(() => view().state.doc.toString() === original, 'go’s Script');
    view().dispatch({
      changes: { from: 0, to: view().state.doc.length, insert: 'broken' },
    });
    document
      .querySelector<HTMLButtonElement>('#perform [data-revert]')!
      .click();
    await until(() => view().state.doc.toString() === original, 'the revert');
    assert(
      shell.editor.project.pages[0]!.elements[0]!.script === original,
      'the Project has the loaded Script again',
    );
  });

  perform().click();
  return results;
};
