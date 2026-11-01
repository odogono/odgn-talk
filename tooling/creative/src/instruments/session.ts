// A Play Session's Instruments (ADR 0158, #1894). Each Instrument is both a
// Grant, whose Capability is its kind, so `tell bass to play "c3"` plays a
// note, and an object whose properties are its parameters, so
// `set the cutoff of bass to 800` changes one. Either way the change becomes
// an InstrumentCommand for the page's audio, which a worker has none of.
import {
  bool,
  defineCapability,
  defineObjectKind,
  num,
  ScriptError,
  shape,
  text,
  type Grant,
  type HostObject,
  type ObjectKind,
  type PropDef,
  type ReleaseHook,
  type Value,
} from '@northtalk/ts';
import { grantAll, type OperationDeclaration } from '../grants/grant';
import type { Instrument, InstrumentParameterValue } from '../model';
import type { DeepReadonly } from '../readonly';
import {
  parameterProblem,
  type InstrumentCommand,
  type InstrumentKind,
  type ParameterDefinition,
} from './kind';
import { noteNumber } from './notes';
import { INSTRUMENT_KINDS } from './registry';

/** Commands for one Instrument, to apply as soon as they arrive. */
export type InstrumentMessage = {
  readonly commands: readonly InstrumentCommand[];
  readonly instrument: string;
};

/** Where a session's Instrument commands go. */
export type InstrumentBackend = (message: InstrumentMessage) => void;

export const silentInstrumentBackend: InstrumentBackend = () => {};

/** Each property's Fuel, as an Element property write costs. */
const SET_FUEL = 1;

const noteOf = (value: Value): number => {
  const note =
    value.kind === 'number'
      ? noteNumber(value.asDecimal()!.toNumberLossy())
      : value.kind === 'text'
        ? noteNumber(value.asText()!)
        : undefined;
  if (note === undefined) {
    throw new ScriptError(
      'out of domain',
      'A note is a MIDI number from 0 to 127 or a name such as "c3" or "f#4"',
    );
  }
  return note;
};

const velocityOf = (value: { toNumberLossy(): number } | null | undefined) => {
  if (value === null || value === undefined) {
    return 1;
  }
  const velocity = value.toNumberLossy();
  if (!(velocity >= 0 && velocity <= 1)) {
    throw new ScriptError(
      'out of domain',
      'A velocity is a number from 0 to 1',
    );
  }
  return velocity;
};

const valueOf = (value: InstrumentParameterValue): Value =>
  typeof value === 'number'
    ? num(value)
    : typeof value === 'boolean'
      ? bool(value)
      : text(value);

const shapeOf = (definition: ParameterDefinition) =>
  definition.shape === 'number'
    ? shape.number
    : definition.shape === 'boolean'
      ? shape.bool
      : shape.text;

/**
 * A declaration without its documentation, which only the Manifest reads.
 * Every Instrument Operation is fire-and-forget.
 */
const declared = ({
  description: _description,
  examples: _examples,
  ...operation
}: OperationDeclaration) => ({
  ...operation,
  mode: 'fire-and-forget' as const,
});

type Played = { readonly instrument: string; readonly note: number };

/** The Instruments of one Play Session. */
export class InstrumentSession {
  readonly #backend: InstrumentBackend;
  readonly #kinds = new Map<string, ObjectKind<string>>();
  readonly #instruments = new Map<
    string,
    {
      readonly kind: InstrumentKind;
      readonly parameters: Record<string, InstrumentParameterValue>;
    }
  >();
  /** The notes each Script has started and not released, by Script name. */
  readonly #played = new Map<string, Played[]>();

  constructor(
    instruments: readonly DeepReadonly<Instrument>[],
    backend: InstrumentBackend = silentInstrumentBackend,
  ) {
    this.#backend = backend;
    for (const instrument of instruments) {
      const kind = INSTRUMENT_KINDS.get(instrument.kind);
      if (kind) {
        this.#instruments.set(instrument.name, {
          kind,
          parameters: { ...instrument.parameters },
        });
      }
    }
  }

  /** The Instruments' names, in authored order. */
  get names(): string[] {
    return [...this.#instruments.keys()];
  }

  /** The object kind for an Instrument kind, its parameters as properties. */
  objectKind(kind: InstrumentKind): ObjectKind<string> {
    const existing = this.#kinds.get(kind.name);
    if (existing) {
      return existing;
    }
    const props: Record<string, PropDef<string>> = {};
    for (const [name, definition] of Object.entries(kind.parameters)) {
      props[name] = {
        shape: shapeOf(definition),
        setCost: { fuel: SET_FUEL },
        get: ({ native }) =>
          valueOf(this.#instruments.get(native)!.parameters[name]!),
        set: ({ native }: HostObject<string>, value: Value) => {
          const next =
            value.kind === 'number'
              ? value.asDecimal()!.toNumberLossy()
              : value.kind === 'boolean'
                ? value.asBool()!
                : value.asText()!;
          const problem = parameterProblem(definition, next);
          if (problem) {
            throw new ScriptError(
              'out of domain',
              `The ${name} of ${native}: ${problem}`,
            );
          }
          this.#instruments.get(native)!.parameters[name] = next;
          this.#send(native, [{ kind: 'set', parameter: name, value: next }]);
        },
      };
    }
    const objectKind = defineObjectKind<string>({ name: kind.name, props });
    this.#kinds.set(kind.name, objectKind);
    return objectKind;
  }

  /** Each Instrument's object kind, by Instrument name. */
  objectKinds(): Map<string, ObjectKind<string>> {
    return new Map(
      [...this.#instruments].map(([name, { kind }]) => [
        name,
        this.objectKind(kind),
      ]),
    );
  }

  /** Each Instrument's Grant, by Instrument name. */
  grants(): Record<string, Grant<unknown>> {
    return Object.fromEntries(
      [...this.#instruments].map(([name, { kind }]) => [
        name,
        this.#grant(name, kind),
      ]),
    );
  }

  /** Releases every note, as a stopped session must. */
  stopAll(): void {
    this.#played.clear();
    for (const name of this.#instruments.keys()) {
      this.#send(name, [{ kind: 'stop' }]);
    }
  }

  #send(instrument: string, commands: InstrumentCommand[]): void {
    this.#backend({ instrument, commands });
  }

  #grant(name: string, kind: InstrumentKind): Grant<unknown> {
    const start = (
      script: string,
      note: number,
      command: InstrumentCommand,
    ) => {
      const played = this.#played.get(script) ?? [];
      played.push({ instrument: name, note });
      this.#played.set(script, played);
      this.#send(name, [command]);
    };
    const release = (script: string, note: number) => {
      const played = this.#played.get(script);
      if (played) {
        this.#played.set(
          script,
          played.filter(p => p.instrument !== name || p.note !== note),
        );
      }
      this.#send(name, [{ kind: 'release', note }]);
    };
    const play =
      kind.name === 'sampler'
        ? {
            ...declared(kind.operations.play!),
            fire: (
              call: { scriptName: string },
              sound: string,
              note: Value | null | undefined,
              velocity: { toNumberLossy(): number } | null | undefined,
            ) => {
              const value =
                note === null || note === undefined ? 60 : noteOf(note);
              start(call.scriptName, value, {
                kind: 'note',
                note: value,
                sound,
                velocity: velocityOf(velocity),
              });
            },
          }
        : {
            ...declared(kind.operations.play!),
            fire: (
              call: { scriptName: string },
              note: Value,
              velocity: { toNumberLossy(): number } | null | undefined,
            ) => {
              const value = noteOf(note);
              start(call.scriptName, value, {
                kind: 'note',
                note: value,
                velocity: velocityOf(velocity),
              });
            },
          };
    // A Script that stops, reloads or loses its Grant releases its notes, so
    // no lifecycle path leaves one sounding.
    const releaseNotes: ReleaseHook<null> = context => {
      for (const played of this.#played.get(context.scriptName) ?? []) {
        if (played.instrument === name) {
          release(context.scriptName, played.note);
        }
      }
    };
    return grantAll(
      defineCapability<null>()(
        kind.name,
        {
          play,
          release: {
            ...declared(kind.operations.release!),
            fire: (call: { scriptName: string }, note: Value) =>
              release(call.scriptName, noteOf(note)),
          },
          stop: {
            ...declared(kind.operations.stop!),
            fire: (call: { scriptName: string }) => {
              this.#played.set(
                call.scriptName,
                (this.#played.get(call.scriptName) ?? []).filter(
                  p => p.instrument !== name,
                ),
              );
              this.#send(name, [{ kind: 'stop' }]);
            },
          },
        },
        undefined,
        releaseNotes,
      ),
      null,
    );
  }
}
