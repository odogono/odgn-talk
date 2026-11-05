import { expect, test } from 'bun:test';
import {
  draggedPosition,
  formatParameter,
  sliderPosition,
  sliderValue,
  steppedValue,
  type NumberParameter,
} from '../../src/instruments/parameter-sliders';
import { parameterTextNumber } from '../../src/instruments/parameter-units';
import { INSTRUMENT_KINDS } from '../../src/instruments/registry';
import { SYNTH_KIND, YM2149_KIND } from '../helpers/instruments';

const synth = INSTRUMENT_KINDS.get(SYNTH_KIND)!.parameters;
const number = (name: string, parameters = synth) =>
  parameters[name] as NumberParameter;

test('a log slider spreads its range evenly by ratio and reaches both ends', () => {
  const cutoff = number('cutoff');
  expect(sliderValue(cutoff, 0)).toBe(20);
  expect(sliderValue(cutoff, 1)).toBe(20_000);
  // Halfway is the geometric middle, not 10 kHz.
  expect(sliderValue(cutoff, 0.5)).toBeGreaterThan(600);
  expect(sliderValue(cutoff, 0.5)).toBeLessThan(700);
  for (const value of [20, 440, 4000, 20_000]) {
    expect(sliderValue(cutoff, sliderPosition(cutoff, value))).toBeCloseTo(
      value,
      -1,
    );
  }
  // An attack of 0 sits at the left end of its log slider.
  expect(sliderValue(number('attack'), 0)).toBe(0);
  expect(sliderPosition(number('attack'), 0)).toBe(0);
});

test('a linear slider is linear, and keeps whole parameters whole', () => {
  expect(sliderValue(number('pan'), 0.5)).toBe(0);
  const ym = INSTRUMENT_KINDS.get(YM2149_KIND)!.parameters;
  expect(sliderValue(number('volume', ym), 0.5)).toBe(8);
});

test('arrow keys step the slider, ⇧ ten times finer, and always move a whole parameter', () => {
  const cutoff = number('cutoff');
  const coarse = steppedValue(cutoff, 4000, 1) - 4000;
  const fine = steppedValue(cutoff, 4000, 1, true) - 4000;
  expect(coarse).toBeGreaterThan(0);
  expect(fine).toBeGreaterThan(0);
  expect(fine).toBeLessThan(coarse / 5);
  expect(steppedValue(cutoff, 20_000, 1)).toBe(20_000);
  const ym = INSTRUMENT_KINDS.get(YM2149_KIND)!.parameters;
  expect(steppedValue(number('volume', ym), 13, 1, true)).toBe(14);
  expect(steppedValue(number('volume', ym), 13, -1)).toBe(12);
});

test('⇧ while dragging moves the slider ten times more slowly', () => {
  expect(draggedPosition(0.5, 20, 200, false)).toBeCloseTo(0.6);
  expect(draggedPosition(0.5, 20, 200, true)).toBeCloseTo(0.51);
  expect(draggedPosition(0.95, 200, 200, false)).toBe(1);
});

test('values are formatted to suit their size', () => {
  expect(formatParameter(number('attack'), 0.005)).toBe('5 ms');
  expect(formatParameter(number('attack'), 0.2)).toBe('0.2 s');
  expect(formatParameter(number('attack'), 0)).toBe('0 s');
  expect(formatParameter(number('cutoff'), 4000)).toBe('4.0 kHz');
  expect(formatParameter(number('cutoff'), 800)).toBe('800 Hz');
  expect(formatParameter(number('resonance'), 0.1234)).toBe('0.123');
});

test('typed values take a Quantity of the parameter’s Kind', () => {
  expect(parameterTextNumber(number('attack'), '5 ms')).toBe(0.005);
  expect(parameterTextNumber(number('attack'), '0.2')).toBe(0.2);
  expect(parameterTextNumber(number('cutoff'), '4.0 kHz')).toBe(4000);
  expect(parameterTextNumber(number('cutoff'), '4kHz')).toBe(4000);
  expect(parameterTextNumber(number('cutoff'), '5 ms')).toBeUndefined();
  expect(parameterTextNumber(number('resonance'), '1 Hz')).toBeUndefined();
  expect(parameterTextNumber(number('resonance'), 'loud')).toBeUndefined();
});
