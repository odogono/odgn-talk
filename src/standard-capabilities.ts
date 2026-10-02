// Chapter 7's fixed Standard Capability declarations. The Host supplies
// costs and durable timer storage; clock.now reads only the Pump's Clock.
import {
  defineCapability,
  type Call,
  type CapabilityDef,
  type Cost,
  type Shape,
} from './capabilities';
import { HostError } from './errors';
import { instant, type Value } from './values';

export type Costs = Readonly<Record<string, Cost>>;
export type TimerImpl = {
  cancel(call: Call<unknown>, name: string): void;
  schedule(
    call: Call<unknown>,
    name: string,
    at: Value,
    message: string,
    args: Value,
  ): void;
};

const costOf = (costs: Costs, name: string): Cost => {
  const cost = costs && Object.hasOwn(costs, name) ? costs[name] : undefined;
  if (
    !cost ||
    !Number.isSafeInteger(cost.fuel) ||
    cost.fuel < 0 ||
    (cost.alloc !== undefined &&
      (!Number.isSafeInteger(cost.alloc) || cost.alloc < 0))
  ) {
    throw new HostError('invalid value', `Invalid or missing cost for ${name}`);
  }
  return Object.freeze({
    fuel: cost.fuel,
    ...(cost.alloc === undefined ? {} : { alloc: cost.alloc }),
  });
};

const fixed = <B>(capability: CapabilityDef<B>): CapabilityDef<B> => {
  for (const op of capability.operations.values()) {
    Object.freeze(op.args);
    Object.freeze(op.errors);
    Object.freeze(op);
  }
  return capability;
};
const instantShape: Shape = Object.freeze({ k: 'kind', kind: 'instant' });
const textShape: Shape = Object.freeze({ k: 'kind', kind: 'text' });
const dataListShape: Shape = Object.freeze({
  k: 'list',
  of: Object.freeze({ k: 'any' }),
});

/** The Pump's Clock reading; there is no Host clock implementation. */
export const clockCapability = (costs: Costs): CapabilityDef<void> =>
  fixed(
    defineCapability('clock', {
      now: {
        mode: 'immediate',
        args: [],
        result: instantShape,
        errors: [],
        cost: costOf(costs, 'now'),
        do: call => instant(call.now),
      },
    }),
  );

/** The Host owns durable timers, scoped by Script and name. */
export const timerCapability = (
  impl: TimerImpl,
  costs: Costs,
): CapabilityDef<unknown> => {
  if (
    !impl ||
    typeof impl.schedule !== 'function' ||
    typeof impl.cancel !== 'function'
  ) {
    throw new HostError('invalid value', 'Timer needs Schedule and Cancel');
  }
  return fixed(
    defineCapability<unknown>('timer', {
      schedule: {
        mode: 'fire-and-forget',
        args: [textShape, instantShape, textShape, dataListShape],
        errors: [],
        cost: costOf(costs, 'schedule'),
        fire: (call, name, at, message, args) =>
          impl.schedule(call, name!.asText()!, at!, message!.asText()!, args!),
      },
      cancel: {
        mode: 'fire-and-forget',
        args: [textShape],
        errors: [],
        cost: costOf(costs, 'cancel'),
        fire: (call, name) => impl.cancel(call, name!.asText()!),
      },
    }),
  );
};
