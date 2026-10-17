// Dedicated page without main.js; exercises the JSX component in the real shell.
import { createProject } from '../src/model';
import { mountStack } from '../src/stack';

const expectTitle = async (expected: string) => {
  for (let i = 0; i < 100; i++) {
    if (document.querySelector('#project-title')?.textContent === expected) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Project title did not become ${JSON.stringify(expected)}`);
};

export const runBrowserTests = async () => {
  const name = 'Project title follows live rename, undo, redo and replacement';
  try {
    const shell = mountStack(createProject('Original Project'));
    await expectTitle('Original Project');
    const input = document.querySelector<HTMLInputElement>(
      '[data-field="projectName"]',
    )!;
    input.focus();
    input.value = 'Renaming';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await expectTitle('Renaming');
    input.value = '<Renamed & ready>';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await expectTitle('<Renamed & ready>');
    input.dispatchEvent(new Event('change', { bubbles: true }));

    shell.editor.undo();
    await expectTitle('Original Project');
    shell.editor.redo();
    await expectTitle('<Renamed & ready>');

    shell.editor.replaceProject(createProject('Loaded Project'));
    await expectTitle('Loaded Project');
    return [{ name, passed: true }];
  } catch (error) {
    return [{ name, passed: false, error: String(error) }];
  }
};
