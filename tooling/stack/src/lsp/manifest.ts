import {
  coreVersions,
  validMessageSelector,
  type GrantDecls,
  type Kind,
  type Shape,
} from '@northtalk/ts';
import { record, string } from './protocol';
export type ManifestOperation = {
  args: Shape[];
  /** Whether it is also a Host Command, called by its name alone (ADR 0094). */
  command: boolean;
  /** The declared cost; a manifest written by `ExportManifest` always has one. */
  cost?: { alloc: number; fuel: number };
  declaration: Record<string, unknown>;
  description?: string;
  errors: string[];
  examples?: string[];
  /** Argument Labels, one per argument after the first, that a call may
   * write between its arguments (ADR 0115); absent when it declares none. */
  labels?: string[];
  /** Whole milliseconds, on a suspending Operation only. */
  maxPending?: number;
  mode: 'immediate' | 'suspending' | 'fire-and-forget';
  name: string;
  result?: Shape;
  scope?: { abandon: string; opens: string } | { closes: string };
  segmentBound: boolean;
};
/** A message a Script may receive, or send to a Host that answers it. */
export type ManifestMessage = {
  args: Shape[];
  description?: string;
  examples?: string[];
  name: string;
};
type ManifestCost = { alloc: number; fuel: number };
export type ManifestObjectKind = {
  elements?: {
    atCost: ManifestCost;
    countCost: ManifestCost;
    findCost: ManifestCost;
    /** The distinct Object Kinds a member may have. */
    kinds: string[];
    shape: Shape;
  };
  name: string;
  props: Map<string, { readOnly: boolean; shape: Shape }>;
};
export type HostManifest = {
  /** Each Grant's Capability, by Grant name. */
  capabilities: Map<string, string>;
  grants: Map<string, Map<string, ManifestOperation>>;
  libraries: { name: string; source: string }[];
  /** Each message's declaration, by name. */
  messageDecls: Map<string, ManifestMessage>;
  messages: string[];
  objectKinds: Map<string, ManifestObjectKind>;
  /** The well-known objects' names. */
  objects: string[];
  /** Each well-known object's kind, by name. */
  objectsKinds: Map<string, string>;
  /** The Owner Kind: the Object Kind of `me`, when the manifest names one. */
  ownerKind?: string;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error('Expected a manifest array');
  }
  return value;
};
const whole = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Expected a whole number in the manifest');
  }
  return value as number;
};
const cost = (value: unknown) => {
  const data = record(value);
  return { fuel: whole(data.fuel), alloc: whole(data.alloc ?? 0) };
};
const scope = (value: unknown): ManifestOperation['scope'] => {
  const data = record(value);
  return 'closes' in data
    ? { closes: string(data.closes) }
    : { opens: string(data.opens), abandon: string(data.abandon) };
};
const kinds = new Set([
  'nothing',
  'boolean',
  'number',
  'quantity',
  'text',
  'bytes',
  'list',
  'map',
  'range',
  'instant',
  'civil date',
  'pattern',
  'function',
  'object',
]);
const shape = (value: unknown, depth = 0): Shape => {
  if (depth > 64) {
    throw new Error('Manifest Shape is too deep');
  }
  if (value === 'any' || value === 'value') {
    return { k: value };
  }
  if (typeof value === 'string' && kinds.has(value)) {
    return { k: 'kind', kind: value as Kind };
  }
  const data = record(value);
  for (const k of ['quantity', 'unitKind', 'object'] as const) {
    if (k in data) {
      const name = string(data[k]);
      return k === 'quantity' ? { k, unit: name } : { k, kind: name };
    }
  }
  if ('list' in data || 'optional' in data) {
    const k = 'list' in data ? 'list' : 'optional';
    return { k, of: shape(data[k], depth + 1) };
  }
  if ('oneOf' in data) {
    return { k: 'oneOf', of: array(data.oneOf).map(v => shape(v, depth + 1)) };
  }
  if ('map' in data) {
    return {
      k: 'map',
      fields: array(data.map).map(value => {
        const field = record(value);
        return {
          key: string(field.key),
          shape: shape(field.shape, depth + 1),
          optional: field.optional === true,
        };
      }),
      open: data.open === true,
    };
  }
  throw new Error('Invalid manifest Shape');
};
const elementShape = (value: unknown) => {
  const result = shape(value);
  const members = result.k === 'oneOf' ? result.of : [result];
  const names = members.flatMap(s => (s.k === 'object' ? [s.kind] : []));
  if (
    !members.length ||
    names.length !== members.length ||
    new Set(names).size !== names.length
  ) {
    throw new Error('Invalid manifest Object Collection Shape');
  }
  return { kinds: names, shape: result };
};
/** Decode data only: never construct Capabilities or execute Host callbacks. */
export const readManifest = (value: unknown): HostManifest => {
  const data = record(typeof value === 'string' ? JSON.parse(value) : value);
  string(data.kind);
  string(data.version);
  if (data.language !== coreVersions.language) {
    throw new Error(`Manifest language must be ${coreVersions.language}`);
  }
  const capabilities = new Map<string, string>();
  const grants = new Map<string, Map<string, ManifestOperation>>();
  for (const value of array(data.grants)) {
    const grant = record(value);
    const name = string(grant.name);
    if (grants.has(name)) {
      throw new Error(`Duplicate Grant ${name}`);
    }
    capabilities.set(name, string(grant.capability));
    const operations = new Map<string, ManifestOperation>();
    for (const value of array(grant.operations)) {
      const op = record(value);
      const mode = op.mode;
      if (
        mode !== 'immediate' &&
        mode !== 'suspending' &&
        mode !== 'fire-and-forget'
      ) {
        throw new Error('Invalid Operation mode');
      }
      const opName = string(op.name);
      if (operations.has(opName)) {
        throw new Error(`Duplicate Operation ${opName}`);
      }
      operations.set(opName, {
        name: opName,
        ...(op.description === undefined
          ? {}
          : { description: string(op.description) }),
        ...(op.examples === undefined
          ? {}
          : { examples: array(op.examples).map(string) }),
        mode,
        args: array(op.args ?? []).map(v => shape(v)),
        ...(op.labels === undefined || !array(op.labels).length
          ? {}
          : { labels: array(op.labels).map(string) }),
        ...(op.result === undefined ? {} : { result: shape(op.result) }),
        ...(op.cost === undefined ? {} : { cost: cost(op.cost) }),
        ...(op.maxPending === undefined
          ? {}
          : { maxPending: whole(op.maxPending) }),
        ...(op.scope === undefined ? {} : { scope: scope(op.scope) }),
        segmentBound: op.segmentBound === true,
        command: op.command === true,
        declaration: op,
        errors: array(op.errors ?? []).map(v => string(record(v).code)),
      });
    }
    grants.set(name, operations);
  }
  const libraries = array(data.libraries).map(v => {
    const lib = record(v);
    return { name: string(lib.name), source: string(lib.source) };
  });
  if (new Set(libraries.map(l => l.name)).size !== libraries.length) {
    throw new Error('Duplicate Library');
  }
  const objectKinds = new Map<string, ManifestObjectKind>();
  for (const value of array(data.objectKinds ?? [])) {
    const kind = record(value);
    const name = string(kind.name);
    if (objectKinds.has(name)) {
      throw new Error(`Duplicate Object Kind ${name}`);
    }
    const props = new Map<string, { readOnly: boolean; shape: Shape }>();
    for (const value of array(kind.props ?? [])) {
      const prop = record(value);
      props.set(string(prop.name), {
        readOnly: prop.readOnly === true,
        shape: shape(prop.shape ?? 'value'),
      });
    }
    const objectKind: ManifestObjectKind = { name, props };
    if (kind.elements !== undefined) {
      const elements = record(kind.elements);
      objectKind.elements = {
        ...elementShape(elements.shape),
        countCost: cost(elements.countCost),
        atCost: cost(elements.atCost),
        findCost: cost(elements.findCost),
      };
    }
    objectKinds.set(name, objectKind);
  }
  const objectsKinds = new Map(
    array(data.objects).map(v => {
      const object = record(v);
      return [string(object.name), string(object.kind)] as const;
    }),
  );
  const ownerKind =
    data.ownerKind === undefined ? undefined : string(data.ownerKind);
  if (ownerKind !== undefined && !objectKinds.has(ownerKind)) {
    throw new Error(`Owner Kind ${ownerKind} is not a declared Object Kind`);
  }
  const messageDecls = new Map<string, ManifestMessage>();
  for (const value of array(data.messages)) {
    const message = record(value);
    const name = string(message.name);
    const args = array(message.args ?? []);
    if (!validMessageSelector(name, args.length)) {
      throw new Error(`Invalid message Selector ${name}`);
    }
    messageDecls.set(name, {
      name,
      args: args.map(v => shape(v)),
      ...(message.description === undefined
        ? {}
        : { description: string(message.description) }),
      ...(message.examples === undefined
        ? {}
        : { examples: array(message.examples).map(string) }),
    });
  }
  return {
    capabilities,
    grants,
    libraries,
    messageDecls,
    messages: [...messageDecls.keys()],
    objectKinds,
    objects: [...objectsKinds.keys()],
    objectsKinds,
    ...(ownerKind === undefined ? {} : { ownerKind }),
  };
};
export const grantDeclarations = (manifest: HostManifest): GrantDecls =>
  Object.fromEntries(
    [...manifest.grants].map(([name, operations]) => [
      name,
      Object.fromEntries(
        [...operations].map(([name, op]) => [
          name,
          {
            mode: op.mode,
            args: op.args,
            command: op.command,
            ...(op.labels ? { labels: op.labels } : {}),
          },
        ]),
      ),
    ]),
  );

/** The Selectors a Host Command answers: its name, and for an Operation with
 * labels, its name and labels for each argument count it accepts past the
 * first, so `move` with `labels = ["to"]` answers `move` and `move:to:`
 * (ADR 0115). Only a trailing Optional suffix may be left off. */
export const commandSelectors = (op: ManifestOperation): string[] => {
  const labels = op.labels ?? [];
  const selectors = [op.name];
  for (let n = 2; n <= labels.length + 1; n++) {
    if (op.args.slice(n).every(s => s.k === 'optional')) {
      selectors.push(`${[op.name, ...labels.slice(0, n - 1)].join(':')}:`);
    }
  }
  return selectors;
};
