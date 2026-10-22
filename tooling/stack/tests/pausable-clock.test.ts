import { expect, test } from 'bun:test';
import { pausableClock } from '../src/pausable-clock';

test('a pausable clock leaves out paused time', () => {
  let now = 1_000_000n;
  let paused = 5;
  const clock = pausableClock(
    () => now,
    () => paused,
  );
  expect(clock()).toBe(1_000_000n);
  now += 10_000n;
  paused += 4;
  expect(clock()).toBe(1_006_000n);
});

test('a pausable clock never goes backwards', () => {
  let now = 1_000_000n;
  let paused = 0;
  const clock = pausableClock(
    () => now,
    () => paused,
  );
  expect(clock()).toBe(1_000_000n);
  paused = 0.5;
  expect(clock()).toBe(1_000_000n);
  now -= 2000n;
  expect(clock()).toBe(1_000_000n);
});
