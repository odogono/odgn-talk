// Run on a dedicated page without main.js, as described in README.md.
// The sample Project (#824) in a real browser: its assets decode, touch
// taps play it at a narrow width with the Page scaled to fit and only
// vertical scrolling, the journal is reader-editable, and Stop
// restores the authored Project exactly.
import { importImage } from '../src/images';
import { mountPlay } from '../src/play-view';
import { createLighthouseProject } from '../src/examples/lighthouse';
import { importSound, isSoundAsset } from '../src/sounds';
import { mountStack } from '../src/stack';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const until = async (check: () => boolean) => {
  for (let i = 0; i < 150; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out');
};

export const runBrowserTests = async () => {
  const { project, assets } = await createLighthouseProject();
  const authored = JSON.stringify(project);
  const shell = mountStack(project);
  // Real decoders, as on import: a sample asset this browser cannot
  // decode fails here rather than as a placeholder on the Page.
  for (const asset of project.assets) {
    const file = new File(
      [assets.get(asset.hash)! as Uint8Array<ArrayBuffer>],
      asset.fileName,
    );
    shell.images.add(
      isSoundAsset(asset) ? await importSound(file) : await importImage(file),
    );
  }
  mountPlay(shell);
  const toggle = document.querySelector<HTMLButtonElement>(
    '#menu [aria-pressed]',
  )!;
  const inReader = (name: string) =>
    document.querySelector<HTMLElement>(`#reader [data-element="${name}"]`);
  const tap = (name: string) =>
    inReader(name)!.dispatchEvent(
      new PointerEvent('click', { bubbles: true, pointerType: 'touch' }),
    );

  toggle.click();
  // A phone-width reader: the Page scales to fit, with no sideways
  // scrolling, and its full height stays reachable by scrolling down.
  const reader = document.querySelector<HTMLElement>('#reader')!;
  reader.style.maxWidth = '390px';
  reader.style.maxHeight = '300px';
  window.dispatchEvent(new Event('resize'));
  await until(() => {
    const rect = document
      .querySelector('#reader .page')!
      .getBoundingClientRect();
    return rect.width <= reader.clientWidth - 32 + 1;
  });
  assert(
    reader.scrollWidth <= reader.clientWidth + 1,
    `Reader scrolls sideways at phone width (${reader.scrollWidth} > ${reader.clientWidth})`,
  );
  // The scaler carries the scaled size, so layout and the visible Page
  // agree, and the rest of the Page is reached by scrolling down.
  const pageRect = document
    .querySelector('#reader .page')!
    .getBoundingClientRect();
  const scalerRect = document
    .querySelector('#reader .play-scale')!
    .getBoundingClientRect();
  assert(
    Math.abs(scalerRect.height - pageRect.height) < 1 &&
      Math.abs(scalerRect.width - pageRect.width) < 1,
    'Scaled Page and its layout size disagree',
  );
  reader.scrollTop = reader.scrollHeight;
  assert(reader.scrollTop > 0, 'Reader does not scroll vertically');
  // Edit-only header controls leave the header in Play, so Stop stays
  // reachable on a phone-width screen.
  assert(
    getComputedStyle(document.querySelector('#save-file')!).display ===
      'none' &&
      getComputedStyle(document.querySelector('#core')!).display === 'none',
    'Edit-only header controls still crowd the Play header',
  );

  // The illustration really decoded and drew.
  await until(() => {
    const image = inReader('harbourArt')!.querySelector('img');
    return !!image && image.naturalWidth > 0;
  });

  // Play the mystery by touch taps.
  tap('examineButton');
  await until(() => !inReader('clueText')!.hidden);
  const journal = inReader('journal')!;
  journal.focus();
  journal.innerText = 'The trapdoor sticks.';
  journal.dispatchEvent(new InputEvent('input', { bubbles: true }));
  tap('toLighthouse');
  await until(() => !!inReader('searchButton'));
  tap('searchButton');
  await until(() => !!inReader('trapdoor'));
  tap('trapdoor');
  await until(() => !inReader('keyText')!.hidden && !inReader('trapdoor'));
  tap('toEnding');
  await until(() => !!inReader('solveButton'));
  tap('solveButton');
  await until(() =>
    inReader('verdict')!.textContent.includes('Mystery solved'),
  );

  // The journal kept the reader's note across navigation.
  tap('endingToHarbour');
  await until(() => !!inReader('journal'));
  assert(
    inReader('journal')!.textContent.includes('The trapdoor sticks.'),
    'Navigation lost the journal note',
  );

  // Stop restores the authored Project exactly: no trapdoor, no
  // reader note, clues hidden again.
  toggle.click();
  assert(JSON.stringify(project) === authored, 'Play mutated authored data');
  assert(
    !document.querySelector('#page [data-element="trapdoor"]'),
    'Created Element leaked into Edit',
  );
  assert(
    document
      .querySelector('#page [data-element="journal"]')!
      .textContent.includes('tap or click here during Play'),
    'Edit kept the reader journal note',
  );

  // A fresh Play Session starts from the authored state.
  toggle.click();
  await until(() => !!inReader('examineButton'));
  assert(inReader('clueText')!.hidden, 'New Play kept the revealed clue');
  assert(
    inReader('examineButton')!.textContent === 'Examine the tide chart',
    'New Play kept the changed label',
  );
  toggle.click();
  reader.style.maxWidth = '';
  reader.style.maxHeight = '';
  return { passed: true };
};
