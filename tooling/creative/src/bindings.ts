// Control bindings (ADR 0162, #1904): a control's value bound straight to
// an Instrument parameter or the Transport's tempo, and a level meter bound
// to an Instrument's output. A binding needs no Script: during Play the page
// sends a bound parameter to the audio worklet itself, and the worker only
// records it, so turning a knob never waits on a Run or costs Fuel.
import { kindOf } from './elements/registry';
import type { ParameterDefinition } from './instruments/kind';
import { INSTRUMENT_KINDS } from './instruments/registry';
import type { Element, InstrumentParameterValue, Page, Project } from './model';
import type { DeepReadonly } from './readonly';
import { MAX_TEMPO, MIN_TEMPO } from './transport';
import { allElements } from './tree/rules';

/**
 * What one field is bound to, as a file writes it: `bass.cutoff` for a
 * parameter, `tempo`, or a meter's `bass` for that Instrument's output.
 */
export type BindingTarget =
  | { instrument: string; kind: 'parameter'; parameter: string }
  | { instrument: string; kind: 'output' }
  | { kind: 'tempo' };

export const TEMPO_BINDING = 'tempo';

/** Reads a binding's text; undefined when it isn't one. */
export const parseBinding = (
  text: string,
  output: boolean,
): BindingTarget | undefined => {
  if (!output && text === TEMPO_BINDING) {
    return { kind: 'tempo' };
  }
  const parts = text.split('.');
  if (output) {
    return parts.length === 1 && parts[0]
      ? { kind: 'output', instrument: parts[0] }
      : undefined;
  }
  return parts.length === 2 && parts[0] && parts[1]
    ? { kind: 'parameter', instrument: parts[0], parameter: parts[1] }
    : undefined;
};

export const formatBinding = (target: BindingTarget): string =>
  target.kind === 'tempo'
    ? TEMPO_BINDING
    : target.kind === 'output'
      ? target.instrument
      : `${target.instrument}.${target.parameter}`;

/** The fields a kind lets bind, and whether they show an output instead. */
export const bindableFields = (
  element: DeepReadonly<Element>,
): { fields: readonly string[]; output: boolean } => {
  const bindings = kindOf(element).bindings;
  return {
    fields: bindings?.fields ?? [],
    output: bindings?.output === true,
  };
};

/** A field's shape, from its kind's property. */
const fieldShape = (element: DeepReadonly<Element>, field: string) =>
  kindOf(element).properties[field]?.shape;

/** The parameter a binding names, if its Instrument's kind is loaded. */
const parameterOf = (
  project: DeepReadonly<Project>,
  instrument: string,
  parameter: string,
): ParameterDefinition | undefined => {
  const found = project.instruments.find(i => i.name === instrument);
  return found
    ? INSTRUMENT_KINDS.get(found.kind)?.parameters[parameter]
    : undefined;
};

/**
 * Why a field's binding can't apply in this Project, if it can't: an
 * Instrument or parameter that isn't there, or a shape that doesn't fit.
 * An Instrument whose kind isn't loaded is the Instrument's problem, not this.
 */
export const bindingProblem = (
  project: DeepReadonly<Project>,
  element: DeepReadonly<Element>,
  field: string,
  text: string,
): string | undefined => {
  const { fields, output } = bindableFields(element);
  if (!fields.includes(field)) {
    return `${field} can't be bound`;
  }
  const target = parseBinding(text, output);
  if (!target) {
    return output
      ? `“${text}” is not an Instrument name`
      : `“${text}” is not tempo or an Instrument parameter such as bass.cutoff`;
  }
  const shape = fieldShape(element, field);
  if (target.kind === 'tempo') {
    return shape === 'number' ? undefined : 'Only a number binds to tempo';
  }
  const instrument = project.instruments.find(
    i => i.name === target.instrument,
  );
  if (!instrument) {
    return `No Instrument is named “${target.instrument}”`;
  }
  if (target.kind === 'output' || !INSTRUMENT_KINDS.has(instrument.kind)) {
    return undefined;
  }
  const parameter = parameterOf(project, target.instrument, target.parameter);
  if (!parameter) {
    return `${target.instrument} has no parameter “${target.parameter}”`;
  }
  return parameter.shape === shape
    ? undefined
    : `${target.instrument}.${target.parameter} is not a ${shape === 'boolean' ? 'switch' : 'number'}`;
};

/** Every binding that can't apply, with its Element, for the Errors window. */
export const bindingProblems = (
  project: DeepReadonly<Project>,
  pages: readonly DeepReadonly<Page>[] = project.pages,
): { element: DeepReadonly<Element>; message: string }[] =>
  pages.flatMap(page =>
    allElements(page.elements).flatMap(element =>
      Object.entries(element.bindings ?? {}).flatMap(([field, text]) => {
        const problem = bindingProblem(project, element, field, text);
        return problem
          ? [
              {
                element,
                message: `${element.name}’s ${field} binding: ${problem}`,
              },
            ]
          : [];
      }),
    ),
  );

/** What a bound field's new value does. */
export type BoundChange =
  | {
      instrument: string;
      kind: 'parameter';
      parameter: string;
      value: InstrumentParameterValue;
    }
  | { kind: 'tempo'; value: number };

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * A ranged control's value goes as it is, within the target's range, since
 * Info gives it the target's range on binding. Any other number, such as an
 * XY pad's 0 to 1, is scaled across the target's range.
 */
const toRange = (
  element: DeepReadonly<Element>,
  value: number,
  min: number,
  max: number,
): number => {
  const ranged = element as unknown as { max?: unknown; min?: unknown };
  return typeof ranged.min === 'number' && typeof ranged.max === 'number'
    ? clamp(value, min, max)
    : min + clamp(value, 0, 1) * (max - min);
};

/** What changing a bound field to `value` sets, if it is bound and can. */
export const boundChange = (
  project: DeepReadonly<Project>,
  element: DeepReadonly<Element>,
  field: string,
  value: number | boolean,
): BoundChange | undefined => {
  const text = element.bindings?.[field];
  if (text === undefined || bindingProblem(project, element, field, text)) {
    return undefined;
  }
  const target = parseBinding(text, false);
  if (target?.kind === 'tempo' && typeof value === 'number') {
    return {
      kind: 'tempo',
      value: Math.round(toRange(element, value, MIN_TEMPO, MAX_TEMPO)),
    };
  }
  if (target?.kind !== 'parameter') {
    return undefined;
  }
  const parameter = parameterOf(project, target.instrument, target.parameter);
  if (!parameter) {
    return undefined;
  }
  if (parameter.shape === 'boolean' && typeof value === 'boolean') {
    return { ...target, value };
  }
  if (parameter.shape === 'number' && typeof value === 'number') {
    const ranged = toRange(element, value, parameter.min, parameter.max);
    return { ...target, value: parameter.whole ? Math.round(ranged) : ranged };
  }
  return undefined;
};

/** The range Info gives a ranged control when it binds to `text`. */
export const bindingRange = (
  project: DeepReadonly<Project>,
  text: string,
): { max: number; min: number } | undefined => {
  if (text === TEMPO_BINDING) {
    return { min: MIN_TEMPO, max: MAX_TEMPO };
  }
  const target = parseBinding(text, false);
  const parameter =
    target?.kind === 'parameter'
      ? parameterOf(project, target.instrument, target.parameter)
      : undefined;
  return parameter?.shape === 'number'
    ? { min: parameter.min, max: parameter.max }
    : undefined;
};

/** The targets a field may bind to here, for Info's menu, by their text. */
export const bindingChoices = (
  project: DeepReadonly<Project>,
  element: DeepReadonly<Element>,
  field: string,
): { label: string; value: string }[] => {
  const { output } = bindableFields(element);
  if (output) {
    return project.instruments.map(i => ({
      value: i.name,
      label: `${i.name} output`,
    }));
  }
  const shape = fieldShape(element, field);
  return [
    ...(shape === 'number' ? [{ value: TEMPO_BINDING, label: 'Tempo' }] : []),
    ...project.instruments.flatMap(instrument =>
      Object.entries(INSTRUMENT_KINDS.get(instrument.kind)?.parameters ?? {})
        .filter(([, parameter]) => parameter.shape === shape)
        .map(([name]) => ({
          value: `${instrument.name}.${name}`,
          label: `${instrument.name} › ${name}`,
        })),
    ),
  ];
};

/** Each meter bound to an output, by the Instrument it shows. */
export const outputMeters = (
  elements: readonly DeepReadonly<Element>[],
): Map<string, DeepReadonly<Element>[]> => {
  const meters = new Map<string, DeepReadonly<Element>[]>();
  for (const element of elements) {
    if (!bindableFields(element).output) {
      continue;
    }
    const instrument = element.bindings?.value;
    if (instrument) {
      meters.set(instrument, [...(meters.get(instrument) ?? []), element]);
    }
  }
  return meters;
};

/** Whether any meter shows an Instrument's output, so the audio reports levels. */
export const hasOutputMeters = (project: DeepReadonly<Project>): boolean =>
  project.pages.some(page => outputMeters(allElements(page.elements)).size > 0);

/**
 * The controls bound to each of `instrument`'s parameters, by parameter, as
 * the Instruments window marks them (#2081): every Page and Palette's.
 */
export const boundControls = (
  project: DeepReadonly<Project>,
  instrument: string,
): Map<string, string[]> => {
  const bound = new Map<string, string[]>();
  for (const page of project.pages) {
    for (const element of allElements(page.elements)) {
      const { output } = bindableFields(element);
      for (const text of Object.values(element.bindings ?? {})) {
        const target = parseBinding(text, output);
        if (target?.kind === 'parameter' && target.instrument === instrument) {
          bound.set(target.parameter, [
            ...(bound.get(target.parameter) ?? []),
            element.name,
          ]);
        }
      }
    }
  }
  return bound;
};
