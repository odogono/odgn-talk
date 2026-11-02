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
import { isAddOnKind, splitAddOnKind } from '../elements/add-on';
import { SAMPLER_OPERATIONS } from './operations';
import { samplerEngine } from './sampler';

const KINDS = new Map<string, InstrumentKind>([
  [samplerEngine.name, { ...samplerEngine, operations: SAMPLER_OPERATIONS }],
]);

/**
 * Every Instrument kind Folio has: its own sampler, then each kind a loaded
 * Add-on registered, by `<url>#<name>` (#1901).
 */
export const INSTRUMENT_KINDS: ReadonlyMap<string, InstrumentKind> = KINDS;

/** Each kind's Object Kind name, as Scripts see its Instruments. */
export const instrumentObjectKindNames = (): Set<string> =>
  new Set([...KINDS.values()].map(kind => kind.name));

/**
 * Registers an Add-on's Instrument kind; the problem when its name, which
 * Scripts see as an Object Kind, is taken, else undefined.
 */
export const registerInstrumentKind = (
  kind: string,
  definition: InstrumentKind,
  names: InstrumentKindNames,
  addOn: { id: string; version: string },
  taken: (name: string) => boolean,
): string | undefined => {
  if (KINDS.has(kind)) {
    return undefined;
  }
  if (
    instrumentObjectKindNames().has(definition.name) ||
    taken(definition.name)
  ) {
    return `another kind is already named ${definition.name}`;
  }
  KINDS.set(kind, definition);
  NAMES.set(kind, names);
  ADD_ONS.set(kind, addOn);
  return undefined;
};

const ADD_ONS = new Map<string, { id: string; version: string }>();

/** The Add-on, and its loaded version, an Instrument kind comes from. */
export const instrumentKindAddOn = (
  kind: string,
): { id: string; version: string } | undefined => ADD_ONS.get(kind);

/** A kind's name in Info, and the name a new Instrument of it is given. */
export type InstrumentKindNames = { label: string; name: string };

const NAMES = new Map<string, InstrumentKindNames>([
  [samplerEngine.name, { label: 'Sampler', name: 'drums' }],
]);

/** `kind`'s names; a missing Add-on kind is named by its own name. */
export const instrumentKindNames = (kind: string): InstrumentKindNames => {
  const own = splitAddOnKind(kind)?.name ?? kind;
  return NAMES.get(kind) ?? { label: own, name: own };
};

/** Whether `kind` is an Add-on's Instrument kind that hasn't loaded. */
export const isMissingInstrumentKind = (kind: string): boolean =>
  !KINDS.has(kind) && isAddOnKind(kind);

/** The Add-on an Instrument of a missing kind needs. */
export const instrumentAddOn = (kind: string): string | undefined =>
  splitAddOnKind(kind)?.addOn;

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
    if (!kind && isAddOnKind(instrument.kind)) {
      // Kept as saved until its Add-on loads, as a placeholder Element is.
      return;
    }
    if (!kind) {
      issues.push({
        path: `${path}.kind`,
        message: `there is no Instrument kind “${instrument.kind}”`,
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
