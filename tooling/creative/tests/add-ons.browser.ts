// Dedicated page: the Tools window lists a built-in Add-on's kinds, and
// adding one loads it, lists it in the Project and draws it (#1901).
import { blobImporter } from '../src/add-ons/loader';
import { pageAddOnLoader, setPageAddOns } from '../src/add-ons/page';
import { askToTrust } from '../src/add-ons/trust-prompt';
import { createProject, type AddOnElement } from '../src/model';
import { mountStack } from '../src/stack';
import counter, {
  COUNTER_ADD_ON,
  COUNTER_ENTRY,
  COUNTER_KIND,
} from './fixtures/counter-add-on';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const wait = () => new Promise(resolve => setTimeout(resolve, 30));
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return;
    }
    await wait();
  }
  throw new Error('Timed out');
};

let imports = 0;
setPageAddOns(
  pageAddOnLoader({
    catalogue: [COUNTER_ENTRY],
    importer: () => {
      imports++;
      return Promise.resolve(counter);
    },
  }),
);
export const shell = mountStack(createProject('Add-on browser checks'));
const { editor } = shell;

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

  await test('the Tools window lists an Add-on kind before it loads', () => {
    const button = document.querySelector<HTMLButtonElement>(
      `#tools [data-kind="${COUNTER_KIND}"]`,
    );
    assert(button?.textContent?.includes('Counter'), 'Counter is listed');
    assert(imports === 0, 'nothing is fetched until it is used');
  });

  await test('adding one loads the Add-on, lists it and draws the kind', async () => {
    document
      .querySelector<HTMLButtonElement>(`#tools [data-kind="${COUNTER_KIND}"]`)!
      .click();
    await until(() => editor.project.pages[0]!.elements.length === 1);
    const element = editor.project.pages[0]!.elements[0] as AddOnElement & {
      count: number;
    };
    assert(element.kind === COUNTER_KIND, `kind is ${element.kind}`);
    assert(element.name === 'counter1', `named ${element.name}`);
    assert(element.count === 0, 'it has its default count');
    const addOns = editor.project.addOns ?? [];
    assert(
      addOns.length === 1 &&
        addOns[0]!.id === COUNTER_ADD_ON &&
        addOns[0]!.version === '1.1.0',
      `addOns ${JSON.stringify(addOns)}`,
    );
    await until(
      () =>
        document.querySelector('#page [data-element="counter1"] .counter')
          ?.textContent === '0',
    );
  });

  await test('a second one reuses the loaded Add-on, and undo removes both', async () => {
    document
      .querySelector<HTMLButtonElement>(`#tools [data-kind="${COUNTER_KIND}"]`)!
      .click();
    await until(() => editor.project.pages[0]!.elements.length === 2);
    assert(imports === 1, `imported ${imports} times`);
    assert(editor.project.addOns?.length === 1, 'listed once');
    editor.undo();
    editor.undo();
    assert(editor.project.pages[0]!.elements.length === 0, 'both undone');
    assert(!editor.project.addOns?.length, 'the Add-on is unlisted again');
  });

  await test('the trust prompt says what trusting means, and declining is the default', async () => {
    const ref = { id: 'https://example.com/pads', version: '0.1.0' };
    const declined = askToTrust([ref]);
    const dialog = document.querySelector<HTMLDialogElement>(
      'dialog.trust-prompt',
    )!;
    assert(dialog.open, 'the prompt is open');
    assert(dialog.textContent!.includes(ref.id), 'it names the Add-on');
    assert(
      dialog.textContent!.includes('reading your other Projects'),
      'it says what a trusted Add-on can do',
    );
    assert(
      document.activeElement?.textContent === 'Don\u2019t trust',
      'declining has focus',
    );
    dialog.querySelector<HTMLButtonElement>('button[value="no"]')!.click();
    assert((await declined) === false, 'declined');
    const accepted = askToTrust([ref]);
    document
      .querySelector<HTMLButtonElement>('dialog.trust-prompt [data-trust]')!
      .click();
    assert((await accepted) === true, 'trusted');
    assert(
      !document.querySelector('dialog.trust-prompt'),
      'the prompt is gone',
    );
  });

  await test("the page's Content Security Policy lets trusted code load", async () => {
    const module = await blobImporter(
      "export default { id: 'https://example.com/csp', version: '1.0.0', kinds: {} };",
    );
    assert(module.id === 'https://example.com/csp', 'the module loaded');
  });

  return results;
};
