// Dedicated page: the Playing Highlight (#2176). While browsing, each
// Pattern Event's text lights in the Code Browser as it sounds, through the
// real Play worker and audio clock; the toggle and Stop put it out.
import { kitSoundAsset } from '../src/base-projects';
import { createProject } from '../src/model';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';
import { mountWindows } from '../src/windows';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (check()) {
      return;
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const project = createProject('Highlight');
const kit = await Promise.all(['bd', 'hh'].map(key => kitSoundAsset(key)));
project.assets.push(...kit.map(sound => sound.asset));
project.pages[0]!.script = 'on openPage\n  loop "bd hh hh"\nend openPage';
const shell = mountStack(project);
// The kit bytes go where Play finds them.
for (const sound of kit) {
  shell.images.add({ ...sound, warnings: [] });
}
mountWindows();
mountPlay(shell);

const play = () =>
  document.querySelector<HTMLButtonElement>('#play-controls [data-play]')!;
const lit = () =>
  [...document.querySelectorAll<HTMLElement>('#code-browser .cm-playing')].map(
    node => node.textContent,
  );
const toggle = () =>
  document.querySelector<HTMLInputElement>(
    '#code-browser [data-playing-highlight]',
  )!;

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

  shell.openScript(shell.editor.project.pages[0]!);
  await until(
    () => !!document.querySelector('#code-browser .cm-editor'),
    'the Code Browser',
  );

  await test('each Pattern Event lights its text as it sounds', async () => {
    assert(toggle().checked, 'the highlight starts on');
    play().click();
    const seen = new Set<string | null>();
    for (let i = 0; i < 300 && seen.size < 2; i++) {
      for (const text of lit()) {
        seen.add(text);
      }
      await sleep(10);
    }
    assert(seen.has('bd') && seen.has('hh'), `lit: ${[...seen].join(', ')}`);
  });

  await test('turning it off puts it out', async () => {
    toggle().click();
    assert(lit().length === 0, 'still lit after the toggle');
    await sleep(1500);
    assert(lit().length === 0, 'lit again while off');
    toggle().click();
    await until(() => lit().length > 0, 'the highlight back on');
  });

  await test('Stop puts it out', async () => {
    play().click();
    await sleep(100);
    assert(lit().length === 0, `still lit after Stop: ${lit().join(', ')}`);
  });

  return results;
};
