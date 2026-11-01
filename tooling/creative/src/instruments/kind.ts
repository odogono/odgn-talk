// An Instrument kind (ADR 0158, #1894): its engine (parameters, voice cap
// and the Chip that plays it) and its Operations as the Host Manifest
// documents them. Each engine's module imports only this file, the notes
// and its own chip, so it can later load as an Add-on (#1901).
import type { Chip } from '../audio/chip-host';
import type { OperationDeclaration } from '../grants/grant';

export type ParameterValue = number | string | boolean;

export type ParameterDefinition =
  | {
      readonly default: number;
      readonly description: string;
      readonly max: number;
      readonly min: number;
      readonly shape: 'number';
      /** Whole numbers only. */
      readonly whole?: boolean;
    }
  | {
      readonly choices: readonly string[];
      readonly default: string;
      readonly description: string;
      readonly shape: 'text';
    }
  | {
      readonly default: boolean;
      readonly description: string;
      readonly shape: 'boolean';
    };

/** What a Play Session asks of an Instrument's Chip. */
export type InstrumentCommand =
  | { readonly kind: 'reset' }
  /// Starts a note at `velocity` from 0 to 1; a sampler also takes a sound.
  | {
      readonly kind: 'note';
      readonly note: number;
      readonly sound?: string;
      readonly velocity: number;
    }
  /// Releases every voice playing `note`.
  | { readonly kind: 'release'; readonly note: number }
  | {
      readonly kind: 'set';
      readonly parameter: string;
      readonly value: ParameterValue;
    }
  /// Releases every voice.
  | { readonly kind: 'stop' };

/** A decoded sound a sampler plays: one or two channels at `sampleRate`. */
export type SampleBuffer = {
  readonly channels: readonly Float32Array[];
  readonly sampleRate: number;
};

/** What a Chip is built from: the authored settings and the Session's sounds. */
export type InstrumentSetup = {
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  readonly sampleRate: number;
  readonly samples: ReadonlyMap<string, SampleBuffer>;
  readonly voices: number;
};

/**
 * What plays an Instrument kind: its parameters, voice cap and Chip. The
 * audio thread needs only this, so engines never import the Core.
 */
export type InstrumentEngine = {
  /** A stereo Chip playing the Instrument. */
  chip(setup: InstrumentSetup): Chip<InstrumentCommand>;
  readonly description: string;
  /** The most voices one Instrument of this kind may have. */
  readonly maxVoices: number;
  readonly name: string;
  readonly parameters: Readonly<Record<string, ParameterDefinition>>;
  /** Voices a new Instrument of this kind gets. */
  readonly voices: number;
};

/** An engine and the Operations Scripts call on it. */
export type InstrumentKind = InstrumentEngine & {
  readonly operations: Readonly<Record<string, OperationDeclaration>>;
};

/** The parameter's problem with `value`, else undefined. */
export const parameterProblem = (
  definition: ParameterDefinition,
  value: unknown,
): string | undefined => {
  switch (definition.shape) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'expected a number';
      }
      if (definition.whole && !Number.isInteger(value)) {
        return 'expected a whole number';
      }
      return value < definition.min || value > definition.max
        ? `expected a number from ${definition.min} to ${definition.max}`
        : undefined;
    case 'text':
      return typeof value === 'string' && definition.choices.includes(value)
        ? undefined
        : `expected one of ${definition.choices.join(', ')}`;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'expected true or false';
  }
};

/** Every parameter's default. */
export const defaultParameters = (
  kind: Pick<InstrumentEngine, 'parameters'>,
): Record<string, ParameterValue> =>
  Object.fromEntries(
    Object.entries(kind.parameters).map(([name, p]) => [name, p.default]),
  );

/**
 * A parameter store that checks each `set`, so a Chip only ever sees valid
 * values. Writes to unknown parameters or with bad values are ignored; the
 * Play Session checks them before they reach the audio thread.
 */
export const parameterStore = (
  kind: Pick<InstrumentKind, 'parameters'>,
  initial: Readonly<Record<string, ParameterValue>>,
) => {
  const values: Record<string, ParameterValue> = {};
  for (const [name, definition] of Object.entries(kind.parameters)) {
    const value = initial[name];
    values[name] =
      value !== undefined && parameterProblem(definition, value) === undefined
        ? value
        : definition.default;
  }
  return {
    number: (name: string): number => values[name] as number,
    text: (name: string): string => values[name] as string,
    flag: (name: string): boolean => values[name] as boolean,
    set(name: string, value: ParameterValue): boolean {
      const definition = kind.parameters[name];
      if (!definition || parameterProblem(definition, value) !== undefined) {
        return false;
      }
      values[name] = value;
      return true;
    },
  };
};
