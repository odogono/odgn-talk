// Dedicated page without main.js; exercises reconciled controls in the real shell.
import {
  createElement,
  createPage,
  createProject,
  ELEMENT_KINDS,
  textOf,
} from '../src/model';
import { mountStack } from '../src/stack';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const field = (name: string) =>
  document.querySelector<HTMLInputElement>(`#info [data-field="${name}"]`)!;
const change = (name: string, value: string, live = false) => {
  const input = field(name);
  input.value = value;
  input.dispatchEvent(new Event(live ? 'input' : 'change', { bubbles: true }));
  return input;
};
const project = createProject('Info fields');
project.pages.push(createPage('other'));
project.pages[0]!.elements = ELEMENT_KINDS.map(kind =>
  createElement(kind, kind),
);
project.assets.push({
  name: 'waves',
  fileName: 'waves.wav',
  hash: 'abc',
  mediaType: 'audio/wav',
  size: 0,
});
export const shell = mountStack(project);

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
  await test('Page fields keep focus and selection through edits and shell redraws', async () => {
    const input = field('projectName');
    input.focus();
    change('projectName', 'Revised title', true);
    input.setSelectionRange(2, 7, 'backward');
    shell.redraw();
    await settle();
    assert(
      field('projectName') === input && document.activeElement === input,
      'Title retains its node and focus',
    );
    assert(
      input.selectionStart === 2 &&
        input.selectionEnd === 7 &&
        input.selectionDirection === 'backward',
      'Title retains its selection',
    );
    assert(
      document.querySelector('#project-title')!.textContent === 'Revised title',
      'Project title follows live input',
    );
    input.dispatchEvent(new Event('change', { bubbles: true }));
    shell.editor.undo();
    await settle();
    assert(field('projectName').value === 'Info fields', 'Undo updates Info');
    shell.editor.redo();
    await settle();
    assert(field('projectName').value === 'Revised title', 'Redo updates Info');
    change('name', 'scene');
    await settle();
    assert(
      document.querySelector('#page-name')!.textContent === 'scene',
      'Page caption follows name',
    );
    assert(
      document.querySelector('#thumbnails')!.textContent!.includes('scene'),
      'Strip follows name',
    );
    change('pageHeight', '550');
    assert(shell.editor.page.height === 550, 'Height edits the Page');
  });
  await test('Element label keeps its caret while Page, strip and suggestions update', async () => {
    shell.editor.click('button');
    await settle();
    const input = field('label');
    input.focus();
    for (const value of ['Go', 'Go now']) {
      change('label', value, true);
      input.setSelectionRange(1, 1);
      shell.redraw();
      await settle();
      assert(
        field('label') === input && document.activeElement === input,
        'Label retains its node and focus',
      );
      assert(
        input.selectionStart === 1 && input.selectionEnd === 1,
        'Label retains its caret',
      );
      assert(
        document.querySelector('#page [data-element="button"]')!.textContent ===
          value,
        'Page follows live label',
      );
      assert(
        document.querySelector('#thumbnails [data-element="button"]')!
          .textContent === value,
        'Thumbnail follows live label',
      );
      assert(
        document.querySelector('#info [data-rename]'),
        'Suggestion appears during a live edit',
      );
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    shell.editor.undo();
    await settle();
    assert(
      field('label').value === 'Button',
      'The whole label edit undoes once',
    );
    shell.editor.redo();
    await settle();
    assert(field('label').value === 'Go now', 'Redo updates the same field');
  });
  await test('Plain text preserves selection and composition across signal updates', async () => {
    shell.editor.click('text');
    await settle();
    const input = document.querySelector<HTMLTextAreaElement>(
      '#info [data-field="text"]',
    )!;
    input.focus();
    input.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true, data: '' }),
    );
    input.value = 'Composing 日本';
    input.setSelectionRange(2, 6, 'backward');
    input.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: '日本',
        inputType: 'insertCompositionText',
        isComposing: true,
      }),
    );
    shell.redraw();
    await settle();
    assert(
      document.querySelector('#info [data-field="text"]') === input &&
        document.activeElement === input,
      'Composition retains its node and focus',
    );
    assert(
      input.value === 'Composing 日本' &&
        input.selectionStart === 2 &&
        input.selectionEnd === 6 &&
        input.selectionDirection === 'backward',
      'Composition text and selection survive',
    );
    const composing = shell.editor.selected[0]!;
    assert(
      composing.kind === 'text' && textOf(composing) === input.value,
      'Composing text reaches the Project',
    );
    input.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: '日本' }),
    );
    input.dispatchEvent(new Event('change', { bubbles: true }));
    change('font', 'serif');
    change('textAlign', 'center');
    const checkbox = field('editable');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    const element = shell.editor.selected[0]!;
    assert(
      element.kind === 'text' &&
        element.font === 'serif' &&
        element.richText[0]!.align === 'center' &&
        element.editable,
      'Selects and checkbox edit text properties',
    );
  });
  await test('An uncommitted name survives unrelated signal updates', async () => {
    shell.editor.click('button');
    await settle();
    const input = field('name');
    input.focus();
    input.value = 'typedName';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.setSelectionRange(1, 5);
    shell.editor.edit(({ tree }) => {
      tree.setProjectName('Unrelated change');
    });
    await settle();
    assert(
      field('name') === input && input.value === 'typedName',
      'Name draft survives a panel update',
    );
    assert(
      document.activeElement === input &&
        input.selectionStart === 1 &&
        input.selectionEnd === 5,
      'Name focus and selection survive',
    );
    // Restore the draft so the next case can test the original button name.
    input.value = 'button';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await test('Name refusal and suggestion update without replacing the field', async () => {
    shell.editor.click('button');
    await settle();
    const input = field('name');
    input.focus();
    change('name', ' button ');
    await settle();
    assert(
      input.value === 'button',
      'Committing an unchanged name trims its draft',
    );
    change('name', 'text');
    await settle();
    assert(
      field('name') === input && input.getAttribute('aria-invalid') === 'true',
      'Invalid name retains its field',
    );
    assert(
      input.value === 'text' && document.querySelector('#name-problem'),
      'Attempt and reason are shown',
    );
    document.querySelector<HTMLButtonElement>('#info [data-rename]')!.click();
    await settle();
    assert(
      field('name') === input &&
        !input.hasAttribute('aria-invalid') &&
        !document.querySelector('#name-problem'),
      'Suggestion clears refusal in place',
    );
    assert(
      shell.editor.selected[0]!.name === input.value,
      'Suggestion renames the Element',
    );
  });
  await test('Read-only controls follow every selection and leave view-only actions enabled', async () => {
    shell.setReadOnly(true);
    const check = () => {
      const controls = [
        ...document.querySelectorAll<HTMLInputElement>(
          '#info button, #info input, #info select, #info textarea',
        ),
      ];
      assert(controls.length > 0, 'Info has controls');
      for (const control of controls) {
        assert(
          control.disabled === !control.hasAttribute('data-view-only'),
          `Read-only state of ${control.outerHTML}`,
        );
      }
    };
    shell.editor.selectPage();
    await settle();
    check();
    assert(
      document.querySelector('#info [data-preview-sound="waves"]'),
      'Sound preview remains available',
    );
    for (const element of shell.editor.page.elements) {
      shell.editor.click(element.name);
      await settle();
      check();
    }
    shell.setReadOnly(false);
    shell.editor.click('text');
    await settle();
    assert(
      !field('text').disabled && !field('font').disabled,
      'Editable controls reenable',
    );
    shell.editor.click('image', { shift: true });
    await settle();
    assert(
      document.querySelector('#info h2')!.textContent === '2 Elements',
      'Multi-selection summary updates',
    );
    assert(
      !document.querySelector('#info [data-field]'),
      'Summary has no stale fields',
    );
    shell.editor.replaceProject(createProject('Loaded'));
    await settle();
    assert(
      field('projectName').value === 'Loaded',
      'Replacement displays Page info',
    );
    assert(
      document.querySelector<HTMLButtonElement>('#info [data-move-page="-1"]')!
        .disabled &&
        document.querySelector<HTMLButtonElement>('#info [data-move-page="1"]')!
          .disabled,
      'First and last Page moves stay disabled',
    );
  });
  return results;
};
