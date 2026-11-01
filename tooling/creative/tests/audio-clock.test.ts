import { expect, test } from 'bun:test';
import { AudioClock, MARGIN_US } from '../src/audio-clock';

const clock = () => {
  const wall = { ms: 0 };
  return { audio: new AudioClock(() => wall.ms), wall };
};

test('the Play clock is the audio clock plus the margin, extrapolated', () => {
  const { audio, wall } = clock();
  expect(audio.active).toBe(false);
  audio.read({ audio: 2, epoch: 0 });
  expect(audio.active).toBe(true);
  expect(audio.now()).toBe(2_000_000n + MARGIN_US);
  wall.ms = 10;
  expect(audio.now()).toBe(2_010_000n + MARGIN_US);
});

test('it never goes backwards when a reading lags', () => {
  const { audio, wall } = clock();
  audio.read({ audio: 1, epoch: 0 });
  wall.ms = 50;
  const before = audio.now();
  audio.read({ audio: 1.04, epoch: 50 });
  expect(audio.now()).toBe(before);
});

test('pause holds the time; resume continues from it', () => {
  const { audio, wall } = clock();
  audio.read({ audio: 0, epoch: 0 });
  wall.ms = 100;
  audio.pause();
  wall.ms = 900;
  expect(audio.now()).toBe(100_000n + MARGIN_US);
  audio.resume();
  wall.ms = 950;
  expect(audio.now()).toBe(150_000n + MARGIN_US);
});

test('a Step moves a paused clock and keeps sounds on the audio clock', () => {
  const { audio } = clock();
  audio.read({ audio: 0, epoch: 0 });
  audio.step(16_000n);
  expect(audio.now()).toBe(MARGIN_US);
  audio.pause();
  audio.step(16_000n);
  expect(audio.now()).toBe(16_000n + MARGIN_US);
  expect(audio.toAudio(1)).toBeCloseTo(0.984, 9);
  audio.resume();
  expect(audio.now()).toBe(16_000n + MARGIN_US);
});

test('a stopped audio clock holds still until it runs', () => {
  const { audio, wall } = clock();
  audio.read({ audio: 0, epoch: 0, running: false });
  wall.ms = 500;
  expect(audio.now()).toBe(MARGIN_US);
  audio.read({ audio: 0, epoch: 500, running: true });
  wall.ms = 600;
  expect(audio.now()).toBe(100_000n + MARGIN_US);
});
