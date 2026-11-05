// The pictures the Instruments window draws for a kind's group views
// (#2084): an envelope's ADSR shape and a low-pass filter's response, in a
// unit box (x from 0 at the left to 1, y from 0 at the bottom to 1), and
// what dragging their handles sets. Every parameter moves along its own
// slider's scale, so a drag here and on the slider agree.
import type { GroupView, ParameterDefinition, ParameterValue } from './kind';
import {
  sliderPosition,
  sliderValue,
  unroundedSliderValue,
  type NumberParameter,
} from './parameter-sliders';

export type Point = { readonly x: number; readonly y: number };

/** A draggable corner, the parameters it sets, and where it sits. */
export type Handle = Point & {
  /** Names the handle, such as `decay`; it is also the role it sets on x. */
  readonly id: string;
};

export type ViewPicture = {
  readonly handles: readonly Handle[];
  /** The outline, left to right. */
  readonly line: readonly Point[];
};

type Values = Readonly<Record<string, ParameterValue>>;
type Parameters = Readonly<Record<string, ParameterDefinition>>;

const clamp = (value: number) => Math.min(1, Math.max(0, value));

const number = (parameters: Parameters, name: string) =>
  parameters[name] as NumberParameter;

/** The parameter's slider position, from 0 to 1. */
const share = (parameters: Parameters, values: Values, name: string) => {
  const definition = number(parameters, name);
  return sliderPosition(definition, Number(values[name] ?? definition.default));
};

// Attack, decay and release each take up to a quarter of the width, as far
// along it as their slider is; the sustain holds for a fixed quarter.
const LANE = 0.25;

const envelopeCorners = (
  view: Extract<GroupView, { view: 'envelope' }>,
  parameters: Parameters,
  values: Values,
) => {
  const attack = LANE * share(parameters, values, view.attack);
  const decay = attack + LANE * share(parameters, values, view.decay);
  const sustain = share(parameters, values, view.sustain);
  const held = decay + LANE;
  const release = held + LANE * share(parameters, values, view.release);
  return { attack, decay, sustain, held, release };
};

// The filter's level axis, in decibels, bottom to top.
const FLOOR_DB = -36;
const CEILING_DB = 30;
const levelY = (db: number) => clamp((db - FLOOR_DB) / (CEILING_DB - FLOOR_DB));

/**
 * The state-variable low-pass's damping for a resonance at `share` of its
 * slider, as the synth plays it: 2 for none, near 0 for a sharp peak.
 */
const damping = (share: number) => 2 - 1.96 * share;

/** The low-pass's level in decibels at `ratio` of the cutoff. */
const lowPassDb = (ratio: number, k: number) =>
  -10 * Math.log10((1 - ratio * ratio) ** 2 + (k * ratio) ** 2);

const FILTER_SAMPLES = 96;

/** The view's outline and its handles at the Instrument's values. */
export const viewPicture = (
  view: GroupView,
  parameters: Parameters,
  values: Values,
): ViewPicture => {
  if (view.view === 'envelope') {
    const c = envelopeCorners(view, parameters, values);
    return {
      line: [
        { x: 0, y: 0 },
        { x: c.attack, y: 1 },
        { x: c.decay, y: c.sustain },
        { x: c.held, y: c.sustain },
        { x: c.release, y: 0 },
      ],
      handles: [
        { id: 'attack', x: c.attack, y: 1 },
        { id: 'decay', x: c.decay, y: c.sustain },
        { id: 'release', x: c.release, y: 0 },
      ],
    };
  }
  const cutoff = number(parameters, view.cutoff);
  const fc = Number(values[view.cutoff] ?? cutoff.default);
  const k = damping(share(parameters, values, view.resonance));
  const line = Array.from({ length: FILTER_SAMPLES + 1 }, (_, i) => {
    const x = i / FILTER_SAMPLES;
    const frequency = unroundedSliderValue(cutoff, x);
    return { x, y: levelY(lowPassDb(frequency / fc, k)) };
  });
  return {
    line,
    handles: [
      {
        id: 'cutoff',
        x: sliderPosition(cutoff, fc),
        y: levelY(lowPassDb(1, k)),
      },
    ],
  };
};

/**
 * The parameter values that dragging `handle` to `point` sets, by name.
 * Each is a value its slider could show.
 */
export const draggedHandle = (
  view: GroupView,
  parameters: Parameters,
  values: Values,
  handle: string,
  point: Point,
): Record<string, number> => {
  const at = (name: string, position: number) =>
    sliderValue(number(parameters, name), clamp(position));
  if (view.view === 'envelope') {
    const c = envelopeCorners(view, parameters, values);
    switch (handle) {
      case 'attack':
        return { [view.attack]: at(view.attack, point.x / LANE) };
      case 'decay':
        return {
          [view.decay]: at(view.decay, (point.x - c.attack) / LANE),
          [view.sustain]: at(view.sustain, point.y),
        };
      case 'release':
        return { [view.release]: at(view.release, (point.x - c.held) / LANE) };
      default:
        return {};
    }
  }
  if (handle !== 'cutoff') {
    return {};
  }
  // The peak at the cutoff is 1/k, so the handle's height gives k.
  const db = FLOOR_DB + clamp(point.y) * (CEILING_DB - FLOOR_DB);
  const k = Math.min(2, Math.max(0.04, 10 ** (-db / 20)));
  return {
    [view.cutoff]: at(view.cutoff, point.x),
    [view.resonance]: at(view.resonance, (2 - k) / 1.96),
  };
};
