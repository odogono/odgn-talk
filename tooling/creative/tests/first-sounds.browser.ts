// Run on /first-sounds-test.html, a page without main.js, as described in
// README.md. A smoke test of First Sounds (#1898) in a real browser: Play
// starts the kits' audio without a problem, a Mute button answers through
// the Page, and Next leads to the following Lesson.
import {
  createFirstSoundsProject,
  LESSONS,
} from '../src/examples/first-sounds';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 250; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

export const runBrowserTests = async () => {
  const { project } = await createFirstSoundsProject();
  const shell = mountStack(project);
  mountPlay(shell);
  const present =
    document.querySelector<HTMLButtonElement>('#present-project')!;
  const inReader = (name: string) =>
    document.querySelector<HTMLElement>(`#reader [data-element="${name}"]`);
  const click = (name: string) =>
    inReader(name)!.dispatchEvent(
      new PointerEvent('click', { bubbles: true, pointerType: 'mouse' }),
    );
  // The Errors window says "No errors." until Play reports one.
  const errors = () => {
    const shown = document.querySelector('#errors-window')?.textContent ?? '';
    return shown.includes('No errors.') ? '' : shown;
  };

  present.click();
  await until(
    () => inReader('title')?.textContent === LESSONS[0]!.title,
    'the first Lesson',
  );
  click('muteBeat');
  await until(
    () => inReader('muteBeat')?.textContent === 'Unmute beat',
    'the Mute button to answer',
  );
  click('next');
  await until(
    () => inReader('title')?.textContent === LESSONS[1]!.title,
    'the second Lesson',
  );
  // The new Page loops its own layer, unmuted.
  await until(
    () => inReader('muteBeat')?.textContent === 'Mute beat',
    'the second Lesson’s Mute button',
  );
  if (errors()) {
    throw new Error(`Play reported problems: ${errors()}`);
  }
  present.click();
  return {
    passed: true,
    checks: ['plays, mutes a layer and leads to the next Lesson'],
  };
};
