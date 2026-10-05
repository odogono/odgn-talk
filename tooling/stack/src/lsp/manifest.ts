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
  declaration: Record<string, unknown>;
  errors: string[];
  mode: 'immediate' | 'suspending' | 'fire-and-forget';
  name: string;
};
export type HostManifest = {
  grants: Map<string, Map<string, ManifestOperation>>;
  libraries: { name: string; source: string }[];
  messages: string[];
  objects: string[];
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error('Expected a manifest array');
  }
  return value;
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
  const grants = new Map<string, Map<string, ManifestOperation>>();
  for (const value of array(data.grants)) {
    const grant = record(value);
    const name = string(grant.name);
    string(grant.capability);
    if (grants.has(name)) {
      throw new Error(`Duplicate Grant ${name}`);
    }
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
        args: array(op.args).map(v => shape(v)),
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
  return {
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
    objects: array(data.objects).map(v => string(record(v).name)),
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
