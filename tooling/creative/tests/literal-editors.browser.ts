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

  await test('it closes when the literal is removed', () => {
    shell.code.replace('on click\nend click');
    assert(windows().length === 0, 'closed');
  });

  return results;
};
