// Dedicated page: Literal Editors (ADR 0175, #2180). A Project listing an
// Add-on with a Literal Editor marks its Mini-Notation literals in the Code
// Browser; each opens one window pinned to its literal, which follows edits,
// greys out while it can't show it, writes back through its host and closes
// once the literal is gone.
import { defineAddOn, type LiteralEditorHost } from '../src/add-ons/api';
import { AddOnLoader } from '../src/add-ons/loader';
import { createProject } from '../src/model';
import { mountStack } from '../src/stack';
import { mountWindows } from '../src/windows';
import { EditorView } from '@codemirror/view';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return;
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const ADD_ON = 'https://northtalk.org/add-ons/test-echo';
const hosts: LiteralEditorHost[] = [];
const heard: { from: number; to: number }[] = [];
const carets: number[] = [];
new AddOnLoader().register(
  defineAddOn({
    id: ADD_ON,
    version: '1.0.0',
    kinds: {},
    literalEditors: {
      echo: {
        label: 'Echo',
        literal: 'mini-notation',
        open: host => {
          hosts.push(host);
          return {
            show: state => {
              host.element.textContent = state.text;
            },
            heard: ({ from, to }) => heard.push({ from, to }),
            caret: at => carets.push(at),
          };
        },
      },
    },
  }),
);

const project = createProject('Literal Editors');
project.addOns = [{ id: ADD_ON, version: '1.0.0' }];
project.script = 'on click\n  loop "c4 e4" on lead\nend click';
const shell = mountStack(project);
mountWindows();

const windows = () => [
  ...document.querySelectorAll<HTMLElement>('.literal-editor-window'),
];
const shown = () =>
  windows()[0]?.querySelector('.literal-editor-body')?.textContent;
const source = () => shell.editor.project.script;

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

  shell.openScript(shell.editor.project);

  await test('the literal is marked, and its mark opens one window', async () => {
    await until(
      () => !!document.querySelector('.literal-editor-mark'),
      'the gutter mark',
    );
    document.querySelector<HTMLButtonElement>('.literal-editor-mark')!.click();
    await until(() => windows().length === 1, 'the window');
    assert(shown() === 'c4 e4', `shows ${shown()}`);
    document.querySelector<HTMLButtonElement>('.literal-editor-mark')!.click();
    assert(windows().length === 1, 'opening it again keeps one window');
  });

  await test('the window follows edits to its literal', () => {
    shell.code.replace(`-- tune\n${source()}`.replace('c4 e4', 'g4 e4'));
    assert(shown() === 'g4 e4', `shows ${shown()}`);
  });

  await test('its host rewrites the literal in the source', () => {
    const problem = hosts[0]!.replace(0, 2, 'a4');
    assert(problem === undefined, `refused: ${problem}`);
    assert(source().includes('"a4 e4"'), source());
    assert(shown() === 'a4 e4', `shows ${shown()}`);
    assert(hosts[0]!.replace(0, 2, '"') !== undefined, 'quotes are refused');
  });

  await test('it greys out while its Mini-Notation is broken', () => {
    shell.code.replace(source().replace('a4 e4', 'a4 [e4'));
    assert(windows()[0]!.classList.contains('unavailable'), 'greyed');
    shell.code.replace(source().replace('a4 [e4', 'a4 e4'));
    assert(!windows()[0]!.classList.contains('unavailable'), 'back');
  });

  await test('it hears its own Pattern Events', () => {
    shell.code.light(0, source(), { from: 3, text: 'a4 e4', to: 5 }, 50);
    assert(heard.at(-1)?.from === 3, JSON.stringify(heard));
  });

  await test('its selection and the Code Browser’s are linked', () => {
    const view = EditorView.findFromDOM(
      document.querySelector<HTMLElement>('#code-browser .cm-editor')!,
    )!;
    hosts[0]!.select(3, 5);
    const { from, to } = view.state.selection.main;
    assert(view.state.sliceDoc(from, to) === 'e4', `selected ${from}–${to}`);
    assert(carets.at(-1) === 3, `caret echoed at ${carets.at(-1)}`);
    view.dispatch({ selection: { anchor: source().indexOf('a4 e4') + 1 } });
    assert(carets.at(-1) === 1, `caret at ${carets.at(-1)}`);
    view.dispatch({ selection: { anchor: 0 } });
    assert(carets.at(-1) === 1, 'outside the literal says nothing');
    const pattern = hosts[0]!.parse('c4 [e4');
    assert(pattern === undefined, 'a broken text has no pattern');
    assert(hosts[0]!.parse('c4 e4')?.layers.length === 1, 'parses');
  });

  await test('deleting a literal closes only its own window', async () => {
    shell.code.replace('on click\n  loop "c4"\n  loop "e4"\nend click');
    await until(() => windows().length === 0, 'the old window closing');
    const opened = hosts.length;
    const mark = (at: number) =>
      document.querySelector<HTMLButtonElement>(
        `.literal-editor-mark[data-at="${at}"]`,
      );
    for (const text of ['c4', 'e4']) {
      const at = source().indexOf(`"${text}"`) + 1;
      await until(() => !!mark(at), `the ${text} mark`);
      mark(at)!.click();
    }
    await until(() => windows().length === 2, 'both windows');
    const [first, second] = hosts.slice(opened);
    const view = EditorView.findFromDOM(
      document.querySelector<HTMLElement>('#code-browser .cm-editor')!,
    )!;
    const line = view.state.doc.line(2);
    view.dispatch({ changes: { from: line.from, to: line.to + 1 } });
    await until(() => windows().length === 1, 'the deleted one closing');
    assert(shown() === 'e4', `the survivor shows ${shown()}`);

    const deleted = source();
    const stale = first!.replace(0, 2, 'g4');
    assert(stale !== undefined, 'the closed window refused');
    assert(source() === deleted, `the closed window wrote: ${source()}`);

    assert(second!.replace(0, 2, 'a4') === undefined, 'the survivor edits');
    assert(source().includes('"a4"'), source());
    assert(shown() === 'a4', `the survivor shows ${shown()}`);

    shell.editor.undo();
    shell.editor.undo();
    await until(() => source().includes('"c4"'), 'the deletion undone');
    assert(windows().length === 1, 'undo reopens nothing');
    assert(shown() === 'e4', `the survivor shows ${shown()}`);
    assert(first!.replace(0, 2, 'g4') !== undefined, 'still refused');
    assert(source().includes('"c4"'), `undo then wrote: ${source()}`);

    const at = source().indexOf('"c4"') + 1;
    await until(() => !!mark(at), 'the restored mark');
    mark(at)!.click();
    await until(() => windows().length === 2, 'reopened explicitly');
    assert(hosts.at(-1)!.replace(0, 2, 'd4') === undefined, 'reopened edits');
    assert(source().includes('"d4"\n  loop "e4"'), source());
  });

  await test('it closes when the literal is removed', () => {
    shell.code.replace('on click\nend click');
    assert(windows().length === 0, 'closed');
  });

  return results;
};
