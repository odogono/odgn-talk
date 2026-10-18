// Run on /message-targets-test.html; exercises the real Play and LSP workers.
import { EditorView } from '@codemirror/view';
import { createPage, createProject } from '../src/model';
import { mountStack } from '../src/stack';
import { mountPlay } from '../src/play-view';

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

export const runBrowserTests = async () => {
  const project = createProject('Targeted Message Box');
  project.script = 'script variable projectScore = 9';
  project.pages[0]!.script = 'script variable score = 3';
  project.pages.push(createPage('page2'));
  const shell = mountStack(project);
  mountPlay(shell);
  document.querySelector<HTMLButtonElement>('#show-message')!.click();
  const win = document.querySelector<HTMLElement>('#message-window')!;
  const selector = win.querySelector('select')!;
  const run = win.querySelector<HTMLButtonElement>('.message-context button')!;
  const view = EditorView.findFromDOM(win.querySelector('.cm-editor')!)!;
  const choose = (label: string) => {
    const option = [...selector.options].find(o => o.textContent === label);
    assert(option, `Missing context: ${label}`);
    selector.value = option!.value;
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const set = (text: string) => {
    // The protected wrapper's final Handler surrounds the visible command.
    const source = view.state.doc.toString();
    const start = source.lastIndexOf('\non folioMessage');
    const from =
      start < 0
        ? source.indexOf('\n') + 1
        : source.indexOf('\n', start + 1) + 1;
    const to = source.lastIndexOf('\nend ');
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
  };
  const submit = (text: string) => {
    set(text);
    run.click();
    return win.querySelector('.message-log')!.lastElementChild!;
  };
  const browse =
    document.querySelector<HTMLButtonElement>('#tool-modes button')!;
  const edit = document.querySelector<HTMLButtonElement>(
    '#tool-modes button:last-child',
  )!;
  browse.click();
  await until(
    () => selector.options.length === 3,
    'Loaded Scripts not offered',
  );
  choose('page:page1');
  assert(
    !view.contentDOM.innerText.includes('script variable'),
    'Loaded source is visible',
  );
  let row = submit('score');
  await until(
    () => row.querySelector('.result')?.textContent === '3',
    'Variable read failed',
  );
  submit('put 8 into score');
  row = submit('score');
  await until(
    () => row.querySelector('.result')?.textContent === '8',
    'Mutation failed',
  );

  // Authored edits must not change the running editor context.
  shell.editor.edit(({ project, tree }) =>
    tree.setScript(project.pages[0]!, 'script variable futureScore = 12'),
  );
  shell.redraw();
  assert(
    view.state.doc.toString().includes('script variable score = 3'),
    'Loaded source changed with authored edit',
  );
  assert(
    !view.state.doc.toString().includes('futureScore'),
    'Future source leaked into context',
  );
  set('put sco');
  await new Promise(resolve => setTimeout(resolve, 300));
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      ctrlKey: true,
      bubbles: true,
    }),
  );
  await until(
    () =>
      [...document.querySelectorAll('.cm-tooltip-autocomplete li')].some(li =>
        li.textContent?.includes('score'),
      ),
    'Loaded variable completion missing',
  );
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );

  const slow = submit('wait 200 ms\nreturn 17');
  const fast = submit('22');
  await until(
    () => fast.querySelector('.result')?.textContent === '22',
    'Fast result missing',
  );
  await until(
    () => slow.querySelector('.result')?.textContent === '17',
    'Delayed result attached to wrong command',
  );

  choose('Default context');
  submit('tell pages to show page2');
  await until(
    () => ![...selector.options].some(o => o.textContent === 'page:page1'),
    'Departed Script still available',
  );
  // Recall the navigation, then the last targeted command.
  for (let i = 0; i < 2; i++) {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
    );
  }
  assert(run.disabled, 'History silently retargeted an unloaded Script');
  choose('Default context');
  submit('tell pages to show page1');
  await until(
    () => [...selector.options].some(o => o.textContent === 'page:page1'),
    'Reloaded Script absent',
  );
  choose('page:page1');
  row = submit('score');
  await until(
    () => row.querySelector('.result')?.textContent === '3',
    'Reloaded Script source absent',
  );
  edit.click();
  assert(
    run.disabled,
    'Stop silently changed a targeted command into an Edit command',
  );
  browse.click();
  await until(
    () => [...selector.options].some(o => o.textContent === 'project'),
    'New session not loaded',
  );
  assert(run.disabled, 'New Play Session silently reused a target');
  choose('project');
  row = submit('projectScore');
  await until(
    () => row.querySelector('.result')?.textContent === '9',
    'Project context failed',
  );
  edit.click();
  shell.editor.replaceProject(createProject('Another Project'));
  shell.redraw();
  assert(
    win.querySelectorAll('.message-log li').length === 0,
    'History log crossed Projects',
  );
  assert(!run.disabled, 'New Project retained unavailable context');
  return {
    passed: true,
    checks: [
      'loaded scope and completion',
      'live mutation',
      'overlapping results',
      'history target invalidation',
      'navigation and session identity',
      'Project history boundary',
    ],
  };
};
