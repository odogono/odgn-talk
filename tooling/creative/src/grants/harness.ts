// The Folio Harness (ADR 0133): granted only to a Test Script. ADR 0056's
// `advance`, plus reader input and read-only Element access. Each input
// answers once everything it started has finished.
import { defineCapability, shape, type Call, type Value } from '@northtalk/ts';
import { grantAll, type GrantDefinition } from './grant';

export type HarnessState = {
  advance(call: Call<unknown>, duration: Value): void;
  click(call: Call<unknown>, element: string, event?: Value | null): void;
  frame(call: Call<unknown>, duration: Value): void;
  goTo(call: Call<unknown>, page: string): void;
  hold(call: Call<unknown>, element: string, duration: Value): void;
  key(call: Call<unknown>, key: string): void;
  page(): Value;
  property(property: string, element: string): Value;
};

// A Harness call waits as long as a suspending call can.
const FOREVER_MS = 2_147_483_647;
const input = (
  args: readonly (typeof shape.text)[],
  description: string,
  example: string,
) =>
  ({
    mode: 'suspending',
    args,
    maxPendingMs: FOREVER_MS,
    cost: { fuel: 0 },
    description,
    examples: [example],
  }) as const;
const duration = shape.quantityKind('exact duration');
const clickShape = shape.map({
  button: { optional: true, shape: shape.number },
  x: { optional: true, shape: shape.number },
  y: { optional: true, shape: shape.number },
});

const operations = {
  advance: {
    ...input(
      [],
      'Moves the Clock on without a `frame`. Each deadline it passes fires in order.',
      'ask harness to advance 2 s and wait',
    ),
    args: [duration],
  },
  click: {
    ...input(
      [],
      'Clicks the named Element of the current Page: a primary click at its centre, unless the map gives `button`, `x` or `y`.',
      'ask harness to click "restartButton" and wait',
    ),
    args: [shape.text, shape.optional(clickShape)],
  },
  frame: {
    ...input(
      [],
      'Moves the Clock on and delivers one `frame`.',
      'ask harness to frame 16 ms and wait',
    ),
    args: [duration],
  },
  goTo: input(
    [shape.text],
    'Closes the current Page and opens the named one.',
    'ask harness to goTo "ending" and wait',
  ),
  hold: {
    ...input(
      [],
      'Presses the named Element of the current Page for the duration: `pointerHeld` every 16 ms, then the `click` its release makes.',
      'ask harness to hold "cell_1_1", 500 ms and wait',
    ),
    args: [shape.text, duration],
  },
  key: input(
    [shape.text],
    'Sends `keyDown`, then `keyUp`, to the current Page.',
    'ask harness to key "ArrowLeft" and wait',
  ),
  page: {
    mode: 'immediate',
    args: [],
    result: shape.text,
    cost: { fuel: 0 },
    description: 'The name of the current Page.',
    examples: ['ask harness to page'],
  },
  property: {
    mode: 'immediate',
    args: [shape.text, shape.text],
    result: shape.any,
    cost: { fuel: 0 },
    description:
      'Reads a property of the named Element of the current Page: its `text`, `visible`, or any other text, number or yes/no property.',
    examples: ['ask harness to property "text", "scoreText"'],
  },
} as const;

export const harnessGrant: GrantDefinition<HarnessState> = {
  name: 'harness',
  operations,
  grant: state =>
    grantAll(
      defineCapability<unknown>()('harness', {
        advance: {
          ...operations.advance,
          examples: [...operations.advance.examples],
          start: (call, value) => state.advance(call, value),
        },
        click: {
          ...operations.click,
          args: [...operations.click.args],
          examples: [...operations.click.examples],
          start: (call, name, event) => state.click(call, name, event),
        },
        frame: {
          ...operations.frame,
          examples: [...operations.frame.examples],
          start: (call, value) => state.frame(call, value),
        },
        goTo: {
          ...operations.goTo,
          args: [...operations.goTo.args],
          examples: [...operations.goTo.examples],
          start: (call, name) => state.goTo(call, name),
        },
        hold: {
          ...operations.hold,
          args: [...operations.hold.args],
          examples: [...operations.hold.examples],
          start: (call, name, value) => state.hold(call, name, value),
        },
        key: {
          ...operations.key,
          args: [...operations.key.args],
          examples: [...operations.key.examples],
          start: (call, key) => state.key(call, key),
        },
        page: {
          ...operations.page,
          args: [],
          examples: [...operations.page.examples],
          do: () => state.page(),
        },
        property: {
          ...operations.property,
          args: [...operations.property.args],
          examples: [...operations.property.examples],
          do: (_call, property, name) => state.property(property, name),
        },
      }),
      undefined,
    ),
};
