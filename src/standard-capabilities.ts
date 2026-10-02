// Chapter 7's fixed Standard Capability declarations. The Host supplies
// costs and I/O; clock.now reads only the Pump's Clock.
import {
  defineCapability,
  type Call,
  type CapabilityDef,
  type Cost,
  type Operation,
  type Shape,
} from './capabilities';
import { HostError } from './errors';
import { ScriptError } from './operations';
import { registerStandardChecks } from './standard-capability-checks';
import { instant, text, type Value } from './values';

export type Costs = Readonly<Record<string, Cost>>;
export type ConsoleImpl = {
  read(call: Call<unknown>): void;
  write(call: Call<unknown>, value: Value): void;
};
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

export const costOf = (costs: Costs, name: string): Cost => {
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

export const fixed = <B>(capability: CapabilityDef<B>): CapabilityDef<B> => {
  for (const op of capability.operations.values()) {
    Object.freeze(op.args);
    Object.freeze(op.errors);
    Object.freeze(op);
  }
  return capability;
};
const instantShape: Shape = Object.freeze({ k: 'kind', kind: 'instant' });
const textShape: Shape = Object.freeze({ k: 'kind', kind: 'text' });
const valueShape: Shape = Object.freeze({ k: 'value' });
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

/** The Host shows Values in text form and answers read with a line of text. */
export const consoleCapability = (
  impl: ConsoleImpl,
  costs: Costs,
): CapabilityDef<unknown> => {
  if (
    !impl ||
    typeof impl.write !== 'function' ||
    typeof impl.read !== 'function'
  ) {
    throw new HostError('invalid value', 'Console needs Write and Read');
  }
  return fixed(
    defineCapability<unknown>('console', {
      write: {
        mode: 'fire-and-forget',
        args: [valueShape],
        errors: [],
        cost: costOf(costs, 'write'),
        fire: (call, value) => impl.write(call, value!),
      },
      read: {
        mode: 'suspending',
        args: [],
        result: textShape,
        errors: [],
        maxPendingMs: 2_147_483_647,
        cost: costOf(costs, 'read'),
        start: call => impl.read(call),
      },
    }),
  );
};

export type CalendarImpl = {
  now(call: Call<string>, zone?: string): Value;
  offset(call: Call<string>, instant: Value, zone?: string): Value;
  toCivil(call: Call<string>, instant: Value, zone?: string): Value;
  today(call: Call<string>, zone?: string): Value;
  toInstant(
    call: Call<string>,
    civil: Value,
    disambiguation: string,
    zone?: string,
  ): Value;
  zone(call: Call<string>, zone?: string): Value;
};
const civilShape: Shape = Object.freeze({ k: 'kind', kind: 'civil date' });
const optionalTextShape: Shape = Object.freeze({
  k: 'optional',
  of: textShape,
});
const secondsShape: Shape = Object.freeze({ k: 'quantity', unit: 's' });
const disambiguations = new Set(['compatible', 'earlier', 'later', 'reject']);
const zoneText = (value: Value | undefined): string | undefined =>
  value?.asText();
const calendarError = (code: string, data: Value): boolean =>
  data.get('zone').kind === 'text' &&
  (code === 'unknown zone' ||
    (code === 'ambiguous time' && data.get('civil').kind === 'civil date'));
const checkToInstant = (args: readonly Value[]): void => {
  const civil = args[0]!;
  const disambiguation = zoneText(args[1]);
  const bad = !('hour' in civil.asCivilDate()!)
    ? civil
    : args.length === 3 &&
        disambiguation !== undefined &&
        !disambiguations.has(disambiguation)
      ? args[1]
      : undefined;
  if (bad) {
    throw new ScriptError(
      'out of domain',
      [
        ['function', text('toInstant')],
        ['value', bad],
      ],
      true,
    );
  }
};

/** The Host owns zone data; the Grant binding supplies its default zone. */
export const calendarCapability = (
  impl: CalendarImpl,
  costs: Costs,
): CapabilityDef<string> => {
  for (const name of [
    'today',
    'now',
    'toCivil',
    'toInstant',
    'offset',
    'zone',
  ] as const) {
    if (!impl || typeof impl[name] !== 'function') {
      throw new HostError('invalid value', `Calendar needs ${name}`);
    }
  }
  const unknownZone = [{ code: 'unknown zone', fields: { zone: textShape } }];
  const operations: Record<string, Operation<string>> = {
    today: {
      mode: 'immediate',
      args: [optionalTextShape],
      result: civilShape,
      errors: unknownZone,
      cost: costOf(costs, 'today'),
      do: (call, zone) => impl.today(call, zoneText(zone)),
    },
    now: {
      mode: 'immediate',
      args: [optionalTextShape],
      result: civilShape,
      errors: unknownZone,
      cost: costOf(costs, 'now'),
      do: (call, zone) => impl.now(call, zoneText(zone)),
    },
    toCivil: {
      mode: 'immediate',
      args: [instantShape, optionalTextShape],
      result: civilShape,
      errors: unknownZone,
      cost: costOf(costs, 'toCivil'),
      do: (call, value, zone) => impl.toCivil(call, value!, zoneText(zone)),
    },
    toInstant: {
      mode: 'immediate',
      args: [civilShape, optionalTextShape, optionalTextShape],
      result: instantShape,
      errors: [
        ...unknownZone,
        {
          code: 'ambiguous time',
          fields: { civil: civilShape, zone: textShape },
        },
      ],
      cost: costOf(costs, 'toInstant'),
      do: (call, ...args) => {
        const second = zoneText(args[1]);
        const isZone =
          args.length === 2 &&
          second !== undefined &&
          !disambiguations.has(second);
        return impl.toInstant(
          call,
          args[0]!,
          isZone ? 'compatible' : (second ?? 'compatible'),
          isZone ? second : zoneText(args[2]),
        );
      },
    },
    offset: {
      mode: 'immediate',
      args: [instantShape, optionalTextShape],
      result: secondsShape,
      errors: unknownZone,
      cost: costOf(costs, 'offset'),
      do: (call, value, zone) => impl.offset(call, value!, zoneText(zone)),
    },
    zone: {
      mode: 'immediate',
      args: [optionalTextShape],
      result: textShape,
      errors: unknownZone,
      cost: costOf(costs, 'zone'),
      do: (call, zone) => impl.zone(call, zoneText(zone)),
    },
  };
  for (const [name, op] of Object.entries(operations)) {
    registerStandardChecks(op, {
      error: calendarError,
      ...(name === 'toInstant' ? { arguments: checkToInstant } : {}),
      ...(['today', 'now', 'toCivil'].includes(name)
        ? {
            result: (value: Value) =>
              !('hour' in value.asCivilDate()!) === (name === 'today'),
          }
        : {}),
    });
  }
  return fixed(defineCapability('calendar', operations));
};
