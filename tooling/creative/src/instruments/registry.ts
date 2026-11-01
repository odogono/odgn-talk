// The Instrument kind registry (ADR 0158, #1894): every kind Folio knows,
// and the checks an authored Instrument must pass, which reading a
// `.folio` file applies.
import { FOLIO_GRANTS } from '../grants';
import { isIdentifierName, type Instrument } from '../model';
import type { DeepReadonly } from '../readonly';
import {
  defaultParameters,
  parameterProblem,
  type InstrumentKind,
} from './kind';
import { NOTE_OPERATIONS, SAMPLER_OPERATIONS } from './operations';
import { samplerEngine } from './sampler';
import { synthEngine } from './synth';
import { ym2149Engine } from './ym2149';

export const INSTRUMENT_KINDS: ReadonlyMap<string, InstrumentKind> = new Map(
  [
    { ...samplerEngine, operations: SAMPLER_OPERATIONS },
    { ...ym2149Engine, operations: NOTE_OPERATIONS },
    { ...synthEngine, operations: NOTE_OPERATIONS },
  ].map(kind => [kind.name, kind]),
);

/** The most voices a Play Session's Instruments may have between them. */
export const SESSION_VOICES = 64;

/**
 * Names an Instrument can't take, because Scripts already bind them to a
 * Grant or an object. Page and Element names are checked with the Scripts.
 */
export const RESERVED_INSTRUMENT_NAMES: ReadonlySet<string> = new Set([
  ...FOLIO_GRANTS.map(grant => grant.name),
  'transport',
  'project',
  'thisPage',
]);

/** A new Instrument of `kind`, with its default voices and parameters. */
export const createInstrument = (kind: string, name: string): Instrument => {
  const definition = INSTRUMENT_KINDS.get(kind);
  if (!definition) {
    throw new Error(`There is no Instrument kind “${kind}”`);
  }
  return {
    name,
    kind,
    voices: definition.voices,
    parameters: defaultParameters(definition),
  };
};

export type InstrumentIssue = { message: string; path: string };

/**
 * Every problem with a Project's Instruments, each with the path of the
 * value at fault, such as `instruments[1].parameters.cutoff`.
 */
export const instrumentProblems = (
  instruments: readonly DeepReadonly<Instrument>[],
): InstrumentIssue[] => {
  const issues: InstrumentIssue[] = [];
  const names = new Set<string>();
  let voices = 0;
  instruments.forEach((instrument, i) => {
    const path = `instruments[${i}]`;
    if (!isIdentifierName(instrument.name)) {
      issues.push({
        path: `${path}.name`,
        message: 'expected a name made of letters, digits and _',
      });
    } else if (RESERVED_INSTRUMENT_NAMES.has(instrument.name)) {
      issues.push({
        path: `${path}.name`,
        message: `“${instrument.name}” is already a name Scripts use`,
      });
    } else if (names.has(instrument.name)) {
      issues.push({
        path: `${path}.name`,
        message: `another Instrument is already called “${instrument.name}”`,
      });
    }
    names.add(instrument.name);
    const kind = INSTRUMENT_KINDS.get(instrument.kind);
    if (!kind) {
      issues.push({
        path: `${path}.kind`,
        message: `expected one of ${[...INSTRUMENT_KINDS.keys()].join(', ')}`,
      });
      return;
    }
    if (
      !Number.isInteger(instrument.voices) ||
      instrument.voices < 1 ||
      instrument.voices > kind.maxVoices
    ) {
      issues.push({
        path: `${path}.voices`,
        message: `expected a whole number from 1 to ${kind.maxVoices}`,
      });
    } else {
      voices += instrument.voices;
    }
    for (const [name, value] of Object.entries(instrument.parameters)) {
      const definition = kind.parameters[name];
      const problem = definition
        ? parameterProblem(definition, value)
        : `a ${kind.name} has no parameter “${name}”`;
      if (problem) {
        issues.push({ path: `${path}.parameters.${name}`, message: problem });
      }
    }
  });
  if (voices > SESSION_VOICES) {
    issues.push({
      path: 'instruments',
      message: `the Instruments have ${voices} voices between them; the most is ${SESSION_VOICES}`,
    });
  }
  return issues;
};
