// Dedicated page without main.js; observes miniature work in the real shell.
import { createElement, createPage, createProject } from '../src/model';
import { mountStack } from '../src/stack';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const drag = (target: Element, type: string, dataTransfer: DataTransfer) => {
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    dataTransfer,
  });
  target.dispatchEvent(event);
  return event;
};
const buttons = () => [
  ...document.querySelectorAll<HTMLButtonElement>('#thumbnails [data-page]'),
];
const miniatures = () =>
  buttons().map(button => button.querySelector<HTMLElement>('.page')!);
const field = (name: string, value: string, live = false) => {
  const input = document.querySelector<HTMLInputElement>(
    `#info [data-field="${name}"]`,
  )!;
  input.value = value;
  input.dispatchEvent(new Event(live ? 'input' : 'change', { bubbles: true }));
};

const project = createProject('Page strip');
project.designWidth = 400;
project.pages[0]!.height = 240;
project.pages[0]!.elements.push(createElement('button', 'go'));
for (const name of ['second', 'third']) {
  const page = createPage(name);
  page.elements.push(createElement('rectangle', 'box'));
  project.pages.push(page);
}
export const shell = mountStack(project);

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
  await settle();
  // Preact writes only what changed, so a miniature that changed records
  // mutations and an unchanged one records none.
  const originals = miniatures();
  const draws = originals.map(() => 0);
  const observer = new MutationObserver(records => {
    const touched = new Set(
      records.map(record =>
        originals.findIndex(node => node.contains(record.target)),
      ),
    );
    for (const index of touched) {
      if (index !== -1) {
        draws[index] = 1;
      }
    }
  });
  originals.forEach(node =>
    observer.observe(node, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    }),
  );
  const expectDraws = (expected: number[]) => {
    assert(
      draws.every((count, index) => count === expected[index]),
      `Miniature draws: expected ${expected}, received ${draws}`,
    );
    draws.fill(0);
  };
  await test('Live Element edits redraw only their Page, including undo and redo', async () => {
    shell.editor.click('go');
    await settle();
    expectDraws([0, 0, 0]);
    for (const label of ['Go', 'Go now']) {
      field('label', label, true);
      await settle();
      assert(originals[0]!.textContent === label, 'Live label reaches strip');
      expectDraws([1, 0, 0]);
    }
    field('label', 'Go now');
    shell.editor.undo();
    await settle();
    assert(originals[0]!.textContent === 'Button', 'Undo restores thumbnail');
    expectDraws([1, 0, 0]);
    shell.editor.redo();
    await settle();
    assert(originals[0]!.textContent === 'Go now', 'Redo restores thumbnail');
    expectDraws([1, 0, 0]);
  });
  await test('Navigation and unrelated Project edits retain every miniature', async () => {
    buttons()[1]!.click();
    await settle();
    assert(shell.editor.pageIndex === 1, 'Click shows second Page');
    assert(
      buttons()[1]!.getAttribute('aria-current') === 'page',
      'Current Page',
    );
    assert(
      !buttons()[0]!.hasAttribute('aria-current'),
      'Previous Page cleared',
    );
    field('projectName', 'Renamed Project');
    shell.redraw();
    await settle();
    document.querySelector<HTMLButtonElement>('#previous-page')!.click();
    await settle();
    assert(shell.editor.pageIndex === 0, 'Previous navigation');
    assert(
      document.querySelector<HTMLButtonElement>('#previous-page')!.disabled,
      'Previous disabled at first Page',
    );
    document.querySelector<HTMLButtonElement>('#next-page')!.click();
    await settle();
    expectDraws([0, 0, 0]);
    assert(
      miniatures().every((node, i) => node === originals[i]),
      'Stable nodes',
    );
  });
  await test('Drag reorder retains keyed Pages and updates indices, labels and navigation', async () => {
    const before = buttons();
    const transfer = new DataTransfer();
    drag(before[0]!, 'dragstart', transfer);
    assert(transfer.getData('application/x-page') === '0', 'Drag source index');
    assert(
      drag(before[2]!, 'dragover', transfer).defaultPrevented,
      'Strip accepts Page drops',
    );
    drag(before[2]!, 'drop', transfer);
    await settle();
    const after = buttons();
    assert(
      after[0] === before[1] &&
        after[1] === before[2] &&
        after[2] === before[0],
      'Buttons move with session-local Page ids',
    );
    after.forEach((button, i) => {
      assert(button.dataset.page === String(i), 'Updated data-page');
      assert(
        button
          .querySelector(':scope > span')!
          .textContent!.startsWith(`${i + 1}. `),
        'Updated Page number',
      );
    });
    assert(
      after[0]!.getAttribute('aria-current') === 'page',
      'Showing Page follows reorder',
    );
    after[2]!.click();
    await settle();
    assert(shell.editor.pageIndex === 2, 'Click uses updated index');
    assert(
      document.querySelector<HTMLButtonElement>('#next-page')!.disabled,
      'Next disabled at last Page',
    );
    expectDraws([0, 0, 0]);
    shell.setReadOnly(true);
    assert(
      drag(after[0]!, 'dragstart', new DataTransfer()).defaultPrevented,
      'Read-only drag refused',
    );
    shell.setReadOnly(false);
  });
  await test('Page height redraws one miniature; design width redraws all', async () => {
    field('pageHeight', '200');
    await settle();
    assert(originals[0]!.style.height === '200px', 'Page height updates');
    assert(
      originals[0]!.parentElement!.style.height === '48px',
      'Frame scales height',
    );
    expectDraws([1, 0, 0]);
    field('designWidth', '800');
    await settle();
    expectDraws([1, 1, 1]);
    miniatures().forEach(node => {
      assert(
        node.style.width === '800px' && node.style.transform === 'scale(0.12)',
        'All miniature widths and transforms update',
      );
    });
    field('name', 'renamed');
    await settle();
    assert(
      buttons()[2]!.title === 'Show renamed; drag to reorder',
      'Page title updates',
    );
    assert(
      buttons()[2]!.textContent!.includes('3. renamed'),
      'Page label updates',
    );
    // A Page's name isn't drawn, so its miniature doesn't change.
    expectDraws([0, 0, 0]);
  });
  await test('Adding, undo, redo and Project replacement reconcile the strip', async () => {
    const before = buttons();
    document.querySelector<HTMLButtonElement>('#add-page')!.click();
    await settle();
    assert(
      buttons().length === 4 &&
        buttons()[3]!.getAttribute('aria-current') === 'page',
      'Added Page appears and is current',
    );
    assert(
      before.every((node, i) => buttons()[i] === node),
      'Existing Pages retained',
    );
    expectDraws([0, 0, 0]);
    shell.editor.undo();
    await settle();
    assert(
      buttons().length === 3 && shell.editor.pageIndex === 2,
      'Undo removes new Page',
    );
    shell.editor.redo();
    await settle();
    assert(buttons().length === 4, 'Redo restores new Page');
    shell.editor.selectPage();
    shell.editor.delete();
    await settle();
    assert(buttons().length === 3, 'Delete removes selected Page');
    shell.editor.replaceProject(createProject('Replacement'));
    await settle();
    assert(
      buttons().length === 1 && !before.includes(buttons()[0]!),
      'Loaded Project gets new ids',
    );
    assert(
      buttons()[0]!.dataset.page === '0' &&
        buttons()[0]!.getAttribute('aria-current') === 'page',
      'Loaded Project navigation resets',
    );
  });
  observer.disconnect();
  return results;
};
