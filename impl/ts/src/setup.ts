// The declaration shared by live Session Groups and Trace replay. Host functions
// and Object adapters are supplied by the caller; loading rules live here.
import {
  type CapabilityDef,
  type Grant,
  shape,
  type FieldShape,
  type Shape,
  type ScopeDecl,
} from './capabilities';
import type { GrantDecls } from './effects';
import type { Limits } from './machine';
import { LoadError } from './errors';
import { newGroup, type Group, type Script } from './group';
import { compileLibrary, type Library } from './library';
import type { HostObject } from './objects';
import type { SqliteBinding } from './sqlite-capability';
import type { TranscriptItem } from './session/transcript';

export type ShapeSpec =
  | string
  | { quantity: string }
  | { unitKind: string }
  | { list: ShapeSpec }
  | { object: string }
  | { oneOf: ShapeSpec[] }
  | { optional: ShapeSpec }
  | {
      map: { key: string; optional?: boolean; shape: ShapeSpec }[];
      open?: boolean;
    };
export type OperationSpec = {
  args?: ShapeSpec[];
  capability: string;
  cost?: { alloc?: number; fuel?: number };
  errors?: {
    code: string;
    fields?: { key: string; optional?: boolean; shape: ShapeSpec }[];
  }[];
  maxPending?: number;
  mode: 'immediate' | 'suspending' | 'fire-and-forget';
  name: string;
  result?: ShapeSpec;
  scope?: ScopeDecl;
  segmentBound?: boolean;
};
export type ObjectRefSpec = { id: string; kind: string };
export type Setup = {
  /** Each Library's source file, or with `text`, the source itself. */
  libraries?: {
    name: string;
    source: string;
    text?: string;
    version: string;
  }[];
  objectKinds?: {
    name: string;
    parentKinds?: string[];
    props?: {
      getCost?: { alloc?: number; fuel: number };
      name: string;
      readOnly?: boolean;
      setCost?: { alloc?: number; fuel: number };
      shape?: ShapeSpec;
    }[];
  }[];
  objects?: { id: string; kind: string; props?: Record<string, string> }[];
  operations?: OperationSpec[];
  scripts?: {
    grants?: Record<
      string,
      {
        binding?: string | SqliteBinding;
        capability?: string;
        coordinator?: string;
        ops: string[] | 'all';
      }
    >;
    grantsAsUsed?: boolean;
    limits?: Partial<Limits>;
    name: string;
    objects?: Record<string, ObjectRefSpec>;
    owner?: ObjectRefSpec;
    /** Its source file, or with `text`, the source itself. */
    source: string;
    text?: string;
  }[];
  sessionObjects?: readonly TranscriptItem[];
  standard?: {
    capability: string;
    costs: Record<string, { alloc?: number; fuel?: number }>;
    perRow?: number;
  }[];
};

export const operationDeclarations = (
  capabilities: ReadonlyMap<string, CapabilityDef<unknown>>,
): GrantDecls => {
  const declarations: Record<
    string,
    Record<string, { args: Shape[]; mode: OperationSpec['mode'] }>
  > = Object.create(null);
  for (const [name, capability] of capabilities) {
    declarations[name] = Object.fromEntries(
      [...capability.operations].map(([operation, op]) => [
        operation,
        { args: op.args ?? [], mode: op.mode },
      ]),
    );
  }
  return declarations;
};

// Every Library case.toml names, compiled once each Library it imports is, so
// in any order; one that never compiles keeps its LoadError.
const compileLibraries = (
  readSource: (file: string) => string,
  setup: Setup,
  declarations: GrantDecls,
): Map<string, Library | LoadError> => {
  const out = new Map<string, Library | LoadError>();
  let pending = setup.libraries ?? [];
  while (pending.length) {
    const failed: typeof pending = [];
    for (const library of pending) {
      try {
        const done = [...out.values()].filter(
          (l): l is Library => !(l instanceof LoadError),
        );
        out.set(
          library.name,
          compileLibrary(
            {
              ...library,
              source: library.text ?? readSource(library.source),
            },
            done,
            declarations,
          ),
        );
      } catch (error) {
        if (!(error instanceof LoadError)) {
          throw error;
        }
        out.set(library.name, error);
        failed.push(library);
      }
    }
    if (failed.length === pending.length) {
      break;
    }
    pending = failed;
  }
  return out;
};

// Carry custom declarations into Trace replay; replay supplies recorded outcomes.
export const shapeSpec = (s: Shape): ShapeSpec => {
  switch (s.k) {
    case 'kind':
      return s.kind;
    case 'any':
    case 'value':
      return s.k;
    case 'quantity':
      return { quantity: s.unit };
    case 'unitKind':
      return { unitKind: s.kind };
    case 'object':
      return { object: s.kind };
    case 'list':
      return { list: shapeSpec(s.of) };
    case 'oneOf':
      return { oneOf: s.of.map(shapeSpec) };
    case 'optional':
      return { optional: shapeSpec(s.of) };
    case 'map':
      return {
        map: s.fields.map(f => ({
          key: f.key,
          optional: f.optional,
          shape: shapeSpec(f.shape),
        })),
        open: s.open,
      };
  }
};
export const capabilityOperations = (
  capabilities: readonly CapabilityDef<unknown>[],
): OperationSpec[] =>
  capabilities.flatMap(c =>
    [...c.operations].map(([name, op]) => ({
      capability: c.name,
      name,
      mode: op.mode,
      args: (op.args ?? []).map(shapeSpec),
      cost: { ...op.cost },
      ...(op.result ? { result: shapeSpec(op.result) } : {}),
      ...(op.errors
        ? {
            errors: op.errors.map(e => ({
              code: e.code,
              fields: Object.entries(e.fields ?? {}).map(([key, field]) => ({
                key,
                ...('shape' in field
                  ? { optional: true, shape: shapeSpec(field.shape) }
                  : { shape: shapeSpec(field) }),
              })),
            })),
          }
        : {}),
    })),
  );

/** Freeze a new declaration without modifying any previous Session Setup. */
export const immutableSetup = (setup: Setup): Setup => {
  const freeze = (value: unknown) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) {
        freeze(child);
      }
      Object.freeze(value);
    }
  };
  freeze(setup);
  return setup;
};

export type SetupGroup = {
  declarations: GrantDecls;
  grants: Map<string, Record<string, Grant<unknown>>>;
  group: Group;
  libraries: Map<string, Library | LoadError>;
  load(
    group: Group,
    name: string,
    objects?: Record<string, HostObject>,
  ): Script;
};

/** Make a Group whose Scripts are loaded only when the Host requests them. */
export const buildSetupGroup = (
  setup: Setup,
  capabilities: ReadonlyMap<string, CapabilityDef<unknown>>,
  options: {
    name: string;
    readSource?(file: string): string;
    resolveObject?(kind: string, id: string): HostObject | undefined;
    trace?(line: string): void;
    // Replay's Coordinator adapter associates a name while making a Grant.
    withCoordinator?<T>(name: string | undefined, make: () => T): T;
  },
): SetupGroup => {
  const group = newGroup({ name: options.name, trace: options.trace });
  const readSource =
    options.readSource ??
    ((file: string): string => {
      throw new Error(`No source reader for ${file}`);
    });
  const declarations = operationDeclarations(capabilities);
  const libraries = compileLibraries(readSource, setup, declarations);
  const bound = new Map<string, Record<string, Grant<unknown>>>();
  const objectOf = (o: ObjectRefSpec): HostObject => {
    const found = options.resolveObject?.(o.kind, o.id);
    if (!found) {
      throw new Error(`case.toml has no object ${o.kind} ${o.id}`);
    }
    return found;
  };
  return {
    group,
    libraries,
    declarations,
    grants: bound,
    load(group, name, objects) {
      const script = setup.scripts?.find(s => s.name === name);
      if (!script) {
        throw new Error(`case.toml has no Script ${name}`);
      }
      const grants: Record<string, Grant<unknown>> = Object.create(null);
      for (const [granted, g] of Object.entries(script.grants ?? {})) {
        const capability = capabilities.get(g.capability ?? granted);
        if (!capability) {
          throw new MissingCapabilityError(g.capability ?? granted);
        }
        if (g.coordinator !== undefined && !capability.coordinator) {
          throw new Error(
            `${capability.name} can't take a coordinator in case.toml`,
          );
        }
        const make = () =>
          capability.grant(
            g.ops,
            g.binding ?? (capability.name === 'locale' ? 'und' : undefined),
          );
        grants[granted] = options.withCoordinator
          ? options.withCoordinator(g.coordinator, make)
          : make();
      }
      bound.set(script.name, grants);
      return group.load({
        grants,
        grantsAsUsed: script.grantsAsUsed,
        name: script.name,
        source: script.text ?? readSource(script.source),
        limits: script.limits,
        objects:
          objects ??
          Object.fromEntries(
            Object.entries(script.objects ?? {}).map(([name, o]) => [
              name,
              objectOf(o),
            ]),
          ),
        ...(script.owner ? { owner: objectOf(script.owner) } : {}),
      });
    },
  };
};

/** The caller decides whether an unavailable Capability is deferred or refused. */
export class MissingCapabilityError extends Error {
  constructor(readonly capability: string) {
    super(`the Standard Capability ${capability}`);
  }
}

const kinds: Record<string, Shape> = {
  any: shape.any,
  value: shape.value,
  nothing: shape.nothing,
  boolean: shape.bool,
  number: shape.number,
  text: shape.text,
  bytes: shape.bytes,
  instant: shape.instant,
  'civil date': shape.civilDate,
  range: shape.range,
  pattern: shape.pattern,
  function: shape.function,
};
// A Shape as case.toml writes it (chapter 11, The setup).
export const shapeOf = (s: ShapeSpec): Shape => {
  if (typeof s === 'string') {
    const k = kinds[s];
    if (!k) {
      throw new Error(`Unknown Shape ${s}`);
    }
    return k;
  }
  if ('quantity' in s) {
    return shape.quantityOf(s.quantity);
  }
  if ('unitKind' in s) {
    return shape.quantityKind(s.unitKind);
  }
  if ('object' in s) {
    // Declarations name Object Kinds, including forward references in properties.
    return { k: 'object', kind: s.object };
  }
  if ('list' in s) {
    return shape.listOf(shapeOf(s.list));
  }
  if ('oneOf' in s) {
    return shape.oneOf(...s.oneOf.map(shapeOf));
  }
  if ('optional' in s) {
    return shape.optional(shapeOf(s.optional));
  }
  if ('map' in s) {
    const fields: Record<string, FieldShape> = Object.fromEntries(
      s.map.map(f => [
        f.key,
        f.optional
          ? { shape: shapeOf(f.shape), optional: true as const }
          : shapeOf(f.shape),
      ]),
    );
    return s.open ? shape.openMap(fields) : shape.map(fields);
  }
  throw new Error('Unknown Shape');
};
