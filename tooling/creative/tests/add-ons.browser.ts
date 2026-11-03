// Dedicated page: Project ▸ Add-ons… lists a built-in Add-on, the Tools
// window then offers its kinds (#2025), and adding one draws it (#1901).
import { blobImporter } from '../src/add-ons/loader';
import { pageAddOnLoader, setPageAddOns } from '../src/add-ons/page';
import {
  generateSigningKeys,
  signAddOn,
  verifyAddOn,
} from '../src/add-ons/signing';
import { askToTrust } from '../src/add-ons/trust-prompt';
import { sha256Hex } from '../src/project-file';
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
const tool = () =>
  document.querySelector<HTMLButtonElement>(
    `#tools [data-kind="${COUNTER_KIND}"]`,
  );
const addOnsDialog = () =>
  document.querySelector<HTMLDialogElement>('dialog.add-ons-dialog');
const tick = () =>
  addOnsDialog()!.querySelector<HTMLInputElement>(
    `[data-add-on="${COUNTER_ADD_ON}"]`,
  )!;
const toggle = () => {
  tick().click();
};

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

  await test('a Project that lists no Add-ons offers none of their kinds', () => {
    assert(!tool(), 'Counter is not offered');
    assert(imports === 0, 'nothing is fetched');
  });

  await test('Project ▸ Add-ons… lists one, and Tools offers its kinds', async () => {
    document.querySelector<HTMLButtonElement>('#show-add-ons')!.click();
    assert(addOnsDialog()?.open, 'the dialog is open');
    assert(!tick().checked, 'the Add-on starts unticked');
    toggle();
    await until(() => editor.project.addOns?.length === 1);
    assert(imports === 1, `imported ${imports} times`);
    await until(() => tool()?.textContent?.includes('Counter') === true);
    assert(tick().checked, 'it is ticked');
  });

  await test('adding one draws the kind', async () => {
    tool()!.click();
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

  await test('unticking is refused while an Element uses it', async () => {
    toggle();
    await until(() => tick().checked);
    const status = addOnsDialog()!.querySelector('[role="status"]')!;
    assert(
      status.textContent!.includes('“counter1” uses it'),
      `it says why: ${status.textContent}`,
    );
    assert(editor.project.addOns?.length === 1, 'still listed');
  });

  await test('once nothing uses it, unticking removes its kinds from Tools', async () => {
    editor.undo();
    assert(!editor.project.pages[0]!.elements.length, 'the counter is undone');
    assert(editor.project.addOns?.length === 1, 'undo leaves it listed');
    toggle();
    await until(() => !editor.project.addOns?.length);
    await until(() => !tool());
    addOnsDialog()!.querySelector<HTMLButtonElement>('button')!.click();
    await until(() => !addOnsDialog());
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

  await test('the browser verifies a NorthTalk signature with WebCrypto (#1967)', async () => {
    const keys = await generateSigningKeys();
    const code = 'export default {}';
    const ref = {
      id: 'https://example.com/pads',
      version: '0.1.0',
      code,
      hash: await sha256Hex(new TextEncoder().encode(code)),
    };
    const signed = await signAddOn(ref, keys.privateKey);
    assert(await verifyAddOn(signed, keys.publicKey), 'a valid one verifies');
    assert(
      !(await verifyAddOn({ ...signed, code: 'x' }, keys.publicKey)),
      'tampered code does not',
    );
    assert(!(await verifyAddOn(signed)), 'another key’s does not');
  });

  await test("the page's Content Security Policy lets trusted code load", async () => {
    const module = await blobImporter(
      "export default { id: 'https://example.com/csp', version: '1.0.0', kinds: {} };",
    );
    assert(module.id === 'https://example.com/csp', 'the module loaded');
  });

  return results;
};
