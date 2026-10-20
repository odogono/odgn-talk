// Run on /performance-test.html, without main.js.
import { createProject } from '../src/model';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';
import { showWindow } from '../src/windows';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out');
};
const node = (id: string) => document.getElementById(id)!;
const status = () => node('performance-status').textContent!;
const shortcut = (target: HTMLElement = node('reader')) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      code: 'KeyP',
      key: 'p',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );

export const runBrowserTests = async () => {
  const project = createProject('Performance');
  project.script = 'on frame elapsed\n wait 50 ms\nend frame';
  const shell = mountStack(project);
  mountPlay(shell);
  const browse = [
    ...document.querySelectorAll<HTMLButtonElement>('#tool-modes button'),
  ].find(b => b.textContent?.includes('Browse'))!;
  const edit = [
    ...document.querySelectorAll<HTMLButtonElement>('#tool-modes button'),
  ].find(b => b.textContent?.includes('Edit'))!;
  const present = document.querySelector<HTMLButtonElement>(
    '#menu > button[aria-pressed]',
  )!;
  assert(node('performance-window').hidden, 'Profiler should start hidden');
  assert(status().includes('No capture'), 'Empty state missing');
  browse.click();
  showWindow('performance-window');
  await until(() => !!document.querySelector('.performance-script'));
  assert(status().includes('Capturing'), 'Capture did not start');
  const details = document.querySelector<HTMLDetailsElement>(
    '.performance-script',
  )!;
  details.open = true;
  await until(() => details.textContent!.includes('busy-skipped'));
  assert(
    document.querySelectorAll('#performance-panel svg').length === 2,
    'Charts missing',
  );
  const before = status();
  shortcut();
  assert(node('performance-window').hidden, 'Shortcut did not close');
  await until(() => status() !== before);
  shortcut();
  assert(!node('performance-window').hidden, 'Shortcut did not reopen');
  const input = document.createElement('input');
  document.body.append(input);
  shortcut(input);
  assert(!node('performance-window').hidden, 'Shortcut intercepted editing');
  input.remove();
  present.click();
  await until(() => status().includes('Capturing'));
  assert(
    getComputedStyle(node('performance-window')).display !== 'none',
    'Profiler hidden in Present',
  );
  assert(document.body.classList.contains('playing'), 'Not presenting');
  node('reader').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await until(() => status().includes('Stopped'));
  const stopped = status();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert(status() === stopped, 'Stopped results kept changing');
  browse.click();
  await until(() => status().includes('Capturing'));
  node('performance-panel').querySelector<HTMLButtonElement>('button')!.click();
  await until(() => status().includes('Capturing'));
  edit.click();
  await until(() => status().includes('Stopped'));
  return {
    passed: true,
    scenarios: [
      'empty',
      'opt-in',
      'charts',
      'hidden capture',
      'shortcut focus',
      'Present',
      'Stop retention',
      'restart',
      'Clear',
    ],
  };
};
