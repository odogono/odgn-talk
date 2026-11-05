// How the Instruments window's sliders and value fields show a number
// parameter (#2079): where a value sits on its slider, linear or
// logarithmic (`scale: 'log'`), how the keyboard and a drag move it, and
// the value as text sized to suit it, such as `5 ms` or `4.0 kHz`.
import type { ParameterDefinition } from './kind';

export type NumberParameter = Extract<ParameterDefinition, { shape: 'number' }>;

/**
 * How steep a log slider is: the ratio between the range's top and its
 * bottom, or 10 000 when the range starts at 0 or below. The curve
 * `min + (max - min)·(e^{kt} - 1)/(e^k - 1)` reaches `min` itself at 0, so
 * an attack of 0 is still on the slider.
 */
const steepness = ({ min, max }: NumberParameter): number =>
  Math.log(Math.max(10, min > 0 ? max / min : 10_000));

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/** Where `value` sits on the parameter's slider, from 0 to 1. */
export const sliderPosition = (
  definition: NumberParameter,
  value: number,
): number => {
  const { min, max } = definition;
  const share = clamp((value - min) / (max - min), 0, 1);
  if (definition.scale !== 'log') {
    return share;
  }
  const k = steepness(definition);
  return Math.log1p(share * Math.expm1(k)) / k;
};

/** The exact value at `position` on the slider, as a curve draws it. */
export const unroundedSliderValue = (
  definition: NumberParameter,
  position: number,
): number => {
  const { min, max } = definition;
  const t = clamp(position, 0, 1);
  const share =
    definition.scale === 'log'
      ? Math.expm1(steepness(definition) * t) /
        Math.expm1(steepness(definition))
      : t;
  return min + share * (max - min);
};

/**
 * The value at `position` on the slider, rounded to three significant
 * digits, or to a whole number for a whole parameter, and kept in range.
 */
export const sliderValue = (
  definition: NumberParameter,
  position: number,
): number => {
  const { min, max } = definition;
  const raw = unroundedSliderValue(definition, position);
  const rounded = definition.whole
    ? Math.round(raw)
    : raw === 0
      ? 0
      : Number(raw.toPrecision(3));
  return clamp(rounded, min, max);
};

/** A keyboard step's share of the slider; ⇧ makes it ten times finer. */
export const STEP = 0.01;
export const FINE = 0.1;

/**
 * The value `steps` slider steps from `value`. A whole parameter always
 * moves by at least one, so every press changes it.
 */
export const steppedValue = (
  definition: NumberParameter,
  value: number,
  steps: number,
  fine = false,
): number => {
  const position =
    sliderPosition(definition, value) + steps * STEP * (fine ? FINE : 1);
  const next = sliderValue(definition, position);
  if (definition.whole && next === value && steps !== 0) {
    return clamp(value + Math.sign(steps), definition.min, definition.max);
  }
  return next;
};

/**
 * The position after a drag of `dx` pixels across a slider `width` pixels
 * wide. ⇧ while dragging moves it ten times more slowly.
 */
export const draggedPosition = (
  position: number,
  dx: number,
  width: number,
  fine: boolean,
): number => clamp(position + (dx / width) * (fine ? FINE : 1), 0, 1);

/** Up to three significant digits, without trailing zeros. */
const short = (value: number): string => String(Number(value.toPrecision(3)));

/**
 * A number parameter's value as the window shows it and Scripts can write
 * it: seconds under 0.1 as `5 ms`, otherwise `0.2 s`; hertz from 1000 as
 * `4.0 kHz`; other Units after the number; whole numbers as they are.
 */
export const formatParameter = (
  definition: NumberParameter,
  value: number,
): string => {
  switch (definition.unit) {
    case 's':
      return value !== 0 && Math.abs(value) < 0.1
        ? `${short(value * 1000)} ms`
        : `${short(value)} s`;
    case 'Hz':
      return Math.abs(value) >= 1000
        ? `${(value / 1000).toFixed(1)} kHz`
        : `${short(value)} Hz`;
    case undefined:
      return definition.whole ? String(value) : short(value);
    default:
      return `${short(value)} ${definition.unit}`;
  }
};
