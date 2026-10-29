// Run on /sonar-test.html, a page without main.js, as described in README.md.
import { createSonarProject } from '../src/examples/sonar';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';

const until = async (check: () => boolean, tries = 150) => {
  for (let i = 0; i < tries; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out');
};

export const runBrowserTests = async () => {
  const { project } = await createSonarProject();
  const shell = mountStack(project);
  mountPlay(shell);
  const toggle = document.querySelector<HTMLButtonElement>(
    '#menu [aria-pressed]',
  )!;
  const reader = document.querySelector<HTMLElement>('#reader')!;
  const status = () =>
    reader.querySelector('[data-element="statusText"]')?.textContent;
  toggle.click();
  await until(() => status() === '10 mines left');
  // The first frame lays out a fresh sea and sets the status again.
  await new Promise(resolve => setTimeout(resolve, 300));
  // Sonar draws every frame, but an idle sea changes no reader DOM: the
  // Canvas repaints its pixels and every other Element is unchanged.
  const changes: string[] = [];
  const observer = new MutationObserver(records => {
    for (const record of records) {
      changes.push(`${record.type} ${record.attributeName ?? ''}`);
    }
  });
  observer.observe(reader, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  observer.disconnect();
  if (changes.length) {
    throw new Error(`An idle frame changed the DOM: ${changes.slice(0, 5)}`);
  }
  toggle.click();
  return { passed: true, checks: ['idle frames leave the DOM alone'] };
};
