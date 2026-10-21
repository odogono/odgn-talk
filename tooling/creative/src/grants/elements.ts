import {
  defineCapability,
  ScriptError,
  shape,
  type HostObject,
  type Value,
} from '@northtalk/ts';
import { ELEMENT_KINDS, type ElementKind } from '../model';
import {
  elementShape,
  grantAll,
  pageShape,
  type GrantDefinition,
} from './grant';

// Construction/disposal consumes a Pump's budget so queued Core parent and
// disposal inputs land before a Script can use the changed object graph.
export const PUMP_FUEL = 5000;

/** Charges the calling Run for tree work; throws once it can't pay. */
export type Charge = (fuel: number) => void;

export type ElementsState = {
  /** The new Element's Object. */
  clone(element: Value, charge: Charge): Value;
  create(
    kind: Exclude<ElementKind, 'group'>,
    page: HostObject,
    name: string | undefined,
    charge: Charge,
  ): Value;
  /** The named Element's Object, absent when the Page has none. */
  find(page: HostObject, name: string): Value | undefined;
  remove(element: Value, charge: Charge): void;
};

const operations = {
  create: {
    mode: 'immediate',
    args: [shape.text, pageShape, shape.optional(shape.text)],
    result: elementShape,
    cost: { fuel: PUMP_FUEL },
  },
  clone: {
    mode: 'immediate',
    args: [elementShape],
    result: elementShape,
    cost: { fuel: PUMP_FUEL },
  },
  delete: {
    mode: 'fire-and-forget',
    args: [elementShape],
    cost: { fuel: PUMP_FUEL },
  },
  find: {
    mode: 'immediate',
    args: [shape.text, pageShape],
    result: elementShape,
    cost: { fuel: 1 },
  },
} as const;

const creatable = (kind: string): kind is Exclude<ElementKind, 'group'> =>
  ELEMENT_KINDS.includes(kind as ElementKind) && kind !== 'group';

export const elementsGrant: GrantDefinition<ElementsState> = {
  name: 'elements',
  operations,
  grant: state =>
    grantAll(
      defineCapability('elements', {
        create: {
          ...operations.create,
          do: (call, kind, page, name) => {
            if (!creatable(kind)) {
              throw new ScriptError('out of domain', 'Unknown Element kind');
            }
            return state.create(
              kind,
              page as HostObject,
              name ?? undefined,
              fuel => call.charge(fuel),
            );
          },
        },
        clone: {
          ...operations.clone,
          do: (call, element) =>
            state.clone(element, fuel => call.charge(fuel)),
        },
        delete: {
          ...operations.delete,
          fire: (call, element) =>
            state.remove(element, fuel => call.charge(fuel)),
        },
        find: {
          ...operations.find,
          do: (_call, name, page) => {
            const element = state.find(page as HostObject, name);
            if (!element) {
              throw new ScriptError('out of domain', 'Element not found');
            }
            return element;
          },
        },
      }),
      undefined,
    ),
};
