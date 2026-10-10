import {
  coreVersions,
  validMessageSelector,
  type GrantDecls,
  type Kind,
  type Shape,
} from '@odgn/northtalk';
import { record, string } from './protocol';
export type ManifestOperation = {
  args: Shape[];
  /** The declared cost; a manifest written by `ExportManifest` always has one. */
  cost?: { alloc: number; fuel: number };
  declaration: Record<string, unknown>;
  errors: string[];
  /** Whole milliseconds, on a suspending Operation only. */
  maxPending?: number;
  mode: 'immediate' | 'suspending' | 'fire-and-forget';
  name: string;
  result?: Shape;
  scope?: { abandon: string; opens: string } | { closes: string };
  segmentBound: boolean;
};
export type ManifestObjectKind = {
  name: string;
  props: Map<string, { readOnly: boolean; shape: Shape }>;
};
export type HostManifest = {
  /** Each Grant's Capability, by Grant name. */
  capabilities: Map<string, string>;
  grants: Map<string, Map<string, ManifestOperation>>;
  libraries: { name: string; source: string }[];
  messages: string[];
  objectKinds: Map<string, ManifestObjectKind>;
  /** The well-known objects' names. */
  objects: string[];
  /** Each well-known object's kind, by name. */
  objectsKinds: Map<string, string>;
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
        mode,
        args: array(op.args ?? []).map(v => shape(v)),
        ...(op.result === undefined ? {} : { result: shape(op.result) }),
        ...(op.cost === undefined ? {} : { cost: cost(op.cost) }),
        ...(op.maxPending === undefined
          ? {}
          : { maxPending: whole(op.maxPending) }),
        ...(op.scope === undefined ? {} : { scope: scope(op.scope) }),
        segmentBound: op.segmentBound === true,
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
    objectKinds.set(name, { name, props });
  }
  const objectsKinds = new Map(
    array(data.objects).map(v => {
      const object = record(v);
      return [string(object.name), string(object.kind)] as const;
    }),
  );
  return {
    capabilities,
    grants,
    libraries,
    messages: array(data.messages).map(v => {
      const message = record(v);
      const name = string(message.name);
      if (!validMessageSelector(name, array(message.args).length)) {
        throw new Error(`Invalid message Selector ${name}`);
      }
      return name;
    }),
    objectKinds,
    objects: [...objectsKinds.keys()],
    objectsKinds,
  };
};
export const grantDeclarations = (manifest: HostManifest): GrantDecls =>
  Object.fromEntries(
    [...manifest.grants].map(([name, operations]) => [
      name,
      Object.fromEntries(
        [...operations].map(([name, op]) => [
          name,
          { mode: op.mode, args: op.args },
        ]),
      ),
    ]),
  );
