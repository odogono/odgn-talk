// Dedicated page without main.js; sets a Breakpoint in the Code Browser's
// gutter, browses until a Run stops there, and resumes it (ADR 0147).
import { EditorView } from '@codemirror/view';
import { createElement, createProject } from '../src/model';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';
import { showWindow } from '../src/windows';

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

const project = createProject('Breakpoints');
const go = createElement('button', 'go');
go.script = [
  'script variable presses = 0',
  'on click {button: 0}',
  ' put 7 into n',
  ' put presses + n into presses',
  'end click',
].join('\n');
project.pages[0]!.elements.push(go);
const note = createElement('text', 'note');
Object.assign(note, { editable: true, top: 200 });
project.pages[0]!.elements.push(note);
const noteNode = () =>
  document.querySelector<HTMLElement>('#reader [data-element="note"]')!;
const shell = mountStack(project);
mountPlay(shell);
const mode = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('#tool-modes button')].find(
    b => b.textContent?.includes(label),
  )!;
const [, pause, step] = document.querySelectorAll<HTMLButtonElement>(
  '#play-controls button',
);
const view = () =>
  EditorView.findFromDOM(
    document.querySelector<HTMLElement>('#code-browser .cm-editor')!,
  )!;
// Clicks the breakpoint gutter beside a line, as an author would.
const clickGutter = (line: number) => {
  const editor = view();
  const coords = editor.coordsAtPos(editor.state.doc.line(line).from)!;
  const gutter = document.querySelector<HTMLElement>(
    '#code-browser .cm-breakpoints',
  )!;
  const x = gutter.getBoundingClientRect().left + 2;
  const y = (coords.top + coords.bottom) / 2;
  // Straight to the gutter: other windows may lie over it.
  gutter.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: y,
    }),
  );
};
// Breakpoint markers, leaving out the gutter's hidden spacer.
const markers = (selector = '.bp') =>
  document.querySelectorAll(
    `#code-browser .cm-gutterElement:not([style*="hidden"]) ${selector}`,
  ).length;
const stopped = () => document.querySelector('.variables-stopped');

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
  await test('a Breakpoint stops a click partway, as a Pause', async () => {
    showWindow('variables-window');
    shell.openScript(shell.editor.project.pages[0]!.elements[0]!);
    await until(
      () => !!document.querySelector('#code-browser .cm-breakpoints'),
      'The Code Browser has no breakpoint gutter',
    );
    clickGutter(4);
    await until(
      () => markers() === 1 && markers('.bp-unverified') === 0,
      'The gutter click set no Breakpoint',
    );
    mode('Browse').click();
    document.querySelector<HTMLElement>('#reader [data-element="go"]')!.click();
    await until(() => !!stopped(), 'The Run never stopped');
    const heading = stopped()!.querySelector('h4')!.textContent;
    assert(heading === 'click in go · line 4', `The frame read ${heading}`);
    const n = [...stopped()!.querySelectorAll('li')].find(
      li => li.querySelector('.name')?.textContent === 'n',
    );
    assert(
      n?.querySelector('.value')?.textContent === '7',
      `The locals read ${stopped()!.textContent}`,
    );
    assert(pause!.textContent === 'Resume', 'Pause did not become Resume');
    assert(
      noteNode().contentEditable === 'false',
      'A reader could type while paused at a Breakpoint',
    );
    assert(
      step!.disabled && step!.title === 'Finish the stopped Run first',
      'Step was not held back',
    );
    assert(
      document.querySelector('#code-browser .cm-paused') !== null,
      'The paused line was not shown',
    );
    const frame = stopped()!.querySelector('.variables-frame')!;
    assert(
      frame.getAttribute('aria-current') === 'true',
      'The innermost frame was not selected',
    );
  });

  await test('Resume finishes the stopped Run', async () => {
    pause!.click();
    await until(() => !stopped(), 'The stopped Run stayed');
    assert(pause!.textContent === 'Pause', 'Play stayed paused');
    await until(
      () => noteNode().contentEditable === 'true',
      'Text stayed read-only after Resume',
    );
    assert(
      document.querySelector('#code-browser .cm-paused') === null,
      'The paused line stayed',
    );
  });

  await test('Step Over past the last line ends the Run, still paused', async () => {
    const over = document.querySelector<HTMLButtonElement>(
      '#play-controls [data-step="over"]',
    )!;
    assert(over.hidden, 'Step Over showed with no Run stopped');
    document.querySelector<HTMLElement>('#reader [data-element="go"]')!.click();
    await until(() => !!stopped(), 'The Run did not stop again');
    assert(!over.hidden, 'Step Over did not show');
    over.click();
    await until(() => !stopped(), 'Step Over did not end the Run');
    assert(pause!.textContent === 'Resume', 'Play did not stay paused');
    assert(over.hidden, 'Step Over stayed after the Run ended');
    pause!.click();
    await until(() => pause!.textContent === 'Pause', 'Resume did not resume');
  });

  await test('an edited source fades its Breakpoints until the next Play', async () => {
    const editor = view();
    editor.dispatch({
      changes: { from: editor.state.doc.length, insert: '\n' },
    });
    await until(
      () => markers('.bp-unverified') === 1,
      'The Breakpoint did not fade',
    );
    document.querySelector<HTMLElement>('#reader [data-element="go"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert(!stopped(), 'A faded Breakpoint stopped a Run');
    mode('Edit').click();
    await until(
      () => markers('.bp-unverified') === 0,
      'The Breakpoint stayed faded in Edit',
    );
  });
  return results;
};
