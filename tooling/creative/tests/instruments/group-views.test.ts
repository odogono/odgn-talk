import { describe, expect, test } from 'bun:test';
import { draggedHandle, viewPicture } from '../../src/instruments/group-views';
import { groupViewsProblem, type GroupView } from '../../src/instruments/kind';
import {
  sliderPosition,
  type NumberParameter,
} from '../../src/instruments/parameter-sliders';
import { synthEngine } from '../../src/instruments/synth';

const { parameters } = synthEngine;
const envelope = synthEngine.views!.Envelope!;
const filter = synthEngine.views!.Filter!;
const defaults = Object.fromEntries(
  Object.entries(parameters).map(([name, p]) => [name, p.default]),
);

describe('group views', () => {
  test('the synth declares valid envelope and filter views', () => {
    expect(groupViewsProblem(synthEngine)).toBeUndefined();
  });

  test('a view must name number parameters in its group', () => {
    const bad: GroupView = { ...filter, resonance: 'gain' } as GroupView;
    expect(groupViewsProblem({ parameters, views: { Filter: bad } })).toContain(
      'resonance',
    );
    expect(groupViewsProblem({ parameters })).toBeUndefined();
  });

  test('the envelope rises to full, falls to sustain and ends at 0', () => {
    const { line } = viewPicture(envelope, parameters, defaults);
    expect(line[0]).toEqual({ x: 0, y: 0 });
    expect(line[1]!.y).toBe(1);
    expect(line[2]!.y).toBeCloseTo(0.7);
    expect(line[4]!.y).toBe(0);
    for (let i = 1; i < line.length; i++) {
      expect(line[i]!.x).toBeGreaterThanOrEqual(line[i - 1]!.x);
    }
  });

  test('dragging a handle to itself keeps its values', () => {
    for (const view of [envelope, filter]) {
      for (const handle of viewPicture(view, parameters, defaults).handles) {
        const values = draggedHandle(
          view,
          parameters,
          defaults,
          handle.id,
          handle,
        );
        for (const [name, value] of Object.entries(values)) {
          expect(value).toBeCloseTo(Number(defaults[name]), 1);
        }
      }
    }
  });

  test('the decay corner sets decay and sustain together', () => {
    const values = draggedHandle(envelope, parameters, defaults, 'decay', {
      x: 0.25,
      y: 0.5,
    });
    expect(values.sustain).toBe(0.5);
    expect(values.decay).toBeGreaterThan(0.1);
  });

  test('the filter handle sits at the cutoff and rises with resonance', () => {
    const low = viewPicture(filter, parameters, defaults).handles[0]!;
    const high = viewPicture(filter, parameters, {
      ...defaults,
      resonance: 0.9,
    }).handles[0]!;
    expect(low.x).toBeCloseTo(
      sliderPosition(parameters.cutoff as NumberParameter, 4000),
    );
    expect(high.y).toBeGreaterThan(low.y);
    const dragged = draggedHandle(filter, parameters, defaults, 'cutoff', {
      x: 1,
      y: high.y,
    });
    expect(dragged.cutoff).toBe(20_000);
    expect(dragged.resonance).toBeCloseTo(0.9, 1);
  });
});
