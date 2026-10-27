// The Folio Harness (ADR 0133): granted only to a Test Script. ADR 0056's
// `advance`, plus reader input and read-only Element access. Each input
// answers once everything it started has finished.
import { defineCapability, shape, type Call, type Value } from '@northtalk/ts';
import { grantAll, type GrantDefinition } from './grant';

export type HarnessState = {
  advance(call: Call<unknown>, duration: Value): void;
  click(call: Call<unknown>, element: string): void;
  frame(call: Call<unknown>, duration: Value): void;
  goTo(call: Call<unknown>, page: string): void;
  key(call: Call<unknown>, key: string): void;
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

const operations = {
  advance: {
    ...input(
      [],
      'Moves the Clock on without a `frame`. Each deadline it passes fires in order.',
      'ask harness to advance 2 s and wait',
    ),
    args: [duration],
  },
  click: input(
    [shape.text],
    'Clicks the named Element of the current Page.',
    'ask harness to click "restartButton" and wait',
  ),
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
  key: input(
    [shape.text],
    'Sends `keyDown`, then `keyUp`, to the current Page.',
    'ask harness to key "ArrowLeft" and wait',
  ),
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
          start: (call, name) => state.click(call, name),
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
        key: {
          ...operations.key,
          args: [...operations.key.args],
          examples: [...operations.key.examples],
          start: (call, key) => state.key(call, key),
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
