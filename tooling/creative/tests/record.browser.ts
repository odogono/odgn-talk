// Run on a dedicated page without main.js, as described in README.md.
import { createElement, createPage, createProject } from '../src/model';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';
import { runProjectTests } from '../src/test-runner';

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
  throw new Error(`Timed out: ${what}`);
};

export const runBrowserTests = async () => {
  const project = createProject('Record check');
  const reveal = createElement('button', 'reveal');
  const secret = createElement('text', 'secret');
  secret.top = 120;
  secret.visible = false;
  project.pages[0]!.elements.push(reveal, secret);
  project.pages[0]!.script = 'on click\n  show secret\nend click\n';
  project.pages.push(createPage('later'));
  const shell = mountStack(project);
  mountPlay(shell);
  // Recording starts on the first Page whichever Page is being edited.
  shell.editor.goToPage(1);
  const record = [
    ...document.querySelectorAll<HTMLButtonElement>('#tool-modes button'),
  ].find(b => b.textContent?.includes('Record Test'))!;
  record.click();
  assert(record.getAttribute('aria-pressed') === 'true', 'Record is pressed');
  const readerButton = () =>
    document.querySelector<HTMLElement>('#reader [data-element="reveal"]');
  await until(() => Boolean(readerButton()), 'the first Page shows');
  readerButton()!.click();
  await new Promise(resolve => setTimeout(resolve, 100));
  record.click();
  await until(
    () => shell.editor.project.testScripts.length === 1,
    'the Recorded Test is added',
  );
  const script = shell.editor.project.testScripts[0]!;
  assert(script.name === 'recorded.test', 'It goes in recorded.test');
  assert(
    script.source.includes('ask harness to click "reveal" and wait') &&
      script.source.includes('assertEqual(it, true)'),
    `It replays the click and checks the reveal:\n${script.source}`,
  );
  assert(
    !document.querySelector<HTMLElement>('.code-browser')!.hidden,
    'The Code Browser opens at it',
  );
  const results = await runProjectTests(shell.editor.project);
  assert(
    results.length === 1 && results[0]!.ok,
    `It passes: ${JSON.stringify(results.map(r => r.problems))}`,
  );
  return {
    passed: true,
    checks: [
      'Record Test Browses the first Page and writes recorded.test',
      'the Recorded Test replays the click, asserts the reveal and passes',
    ],
  };
};
