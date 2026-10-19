// Private snapshot wire encoding. Keep the logical graph independent of its
// compact representation so reconstruction and machine validation stay shared.
import { HostError } from './errors';
import type { Graph } from './snapshot';

type Atom = Graph['root'];
type PackedAtom =
  boolean | number | string | null | [number, (number | string)?];
export type PackedGraph = {
  externals: string[];
  keys: string[];
  nodes: [number, unknown][];
  root: PackedAtom;
};

// These tags belong to saveFormatVersion, never to the public Value Encoding.
const kinds = [
  'object',
  'array',
  'map',
  'set',
  'run',
  'error',
  'abort',
  'bytes',
  'value',
  'pattern',
  'object-value',
  'function',
  'list',
  'value-map',
  'core-map',
] as const;
const atomKinds = ['undefined', 'bigint', 'external', 'ref'] as const;
const invalid = (): never => {
  throw new HostError('invalid save');
};
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);

export const packGraph = (graph: Graph): PackedGraph => {
  const keys: string[] = [],
    externals: string[] = [];
  const keyIds = new Map<string, number>(),
    externalIds = new Map<string, number>();
  const intern = (s: string, strings: string[], ids: Map<string, number>) => {
    let id = ids.get(s);
    if (id === undefined) {
      id = strings.length;
      strings.push(s);
      ids.set(s, id);
    }
    return id;
  };
  const atom = (a: Atom): PackedAtom => {
    if (!Array.isArray(a)) {
      return a;
    }
    const tag = atomKinds.indexOf(a[0] as (typeof atomKinds)[number]);
    return tag === 0
      ? [0]
      : [tag, tag === 2 ? intern(String(a[1]), externals, externalIds) : a[1]!];
  };
  const nodes: PackedGraph['nodes'] = graph.nodes.map(n => {
    let data: unknown = n.data;
    switch (n.kind) {
      case 'object':
        data = (n.data as [string, Atom][]).map(([key, value]) => [
          intern(key, keys, keyIds),
          atom(value),
        ]);
        break;
      case 'value-map':
      case 'core-map':
        data = (n.data as [string, Atom][]).map(([key, value]) => [
          key,
          atom(value),
        ]);
        break;
      case 'map':
        data = (n.data as [Atom, Atom][]).map(([key, value]) => [
          atom(key),
          atom(value),
        ]);
        break;
      case 'array':
      case 'set':
      case 'list':
        data = (n.data as Atom[]).map(atom);
        break;
      case 'run':
      case 'error':
      case 'object-value':
      case 'function':
        data = atom(n.data as Atom);
        break;
    }
    const tag = kinds.indexOf(n.kind as (typeof kinds)[number]);
    if (tag < 0) {
      invalid();
    }
    return [tag, data];
  });
  return { keys, externals, root: atom(graph.root), nodes };
};

const index = (n: unknown, length: number): number => {
  if (
    typeof n !== 'number' ||
    !Number.isSafeInteger(n) ||
    n < 0 ||
    n >= length
  ) {
    invalid();
  }
  return n as number;
};

// Validate every record, including unreachable ones, before any Host callback.
export const unpackGraph = (wire: PackedGraph): Graph => {
  const dictionary = (value: unknown): string[] => {
    if (
      !Array.isArray(value) ||
      value.some(s => typeof s !== 'string') ||
      new Set(value).size !== value.length
    ) {
      invalid();
    }
    return value as string[];
  };
  const keys = dictionary(wire.keys),
    externals = dictionary(wire.externals);
  if (keys.some(k => unsafe.has(k)) || !Array.isArray(wire.nodes)) {
    invalid();
  }

  const atom = (a: unknown): Atom => {
    if (
      a === null ||
      typeof a === 'boolean' ||
      typeof a === 'string' ||
      (typeof a === 'number' && Number.isFinite(a))
    ) {
      return a;
    }
    if (!Array.isArray(a)) {
      return invalid();
    }
    if (a.length === 1 && a[0] === 0) {
      return ['undefined'];
    }
    if (a.length !== 2) {
      return invalid();
    }
    switch (a[0]) {
      case 1:
        if (typeof a[1] !== 'string' || !/^(?:0|-?[1-9]\d*)$/.test(a[1])) {
          return invalid();
        }
        return ['bigint', a[1]];
      case 2:
        return ['external', externals[index(a[1], externals.length)]!];
      case 3:
        return ['ref', index(a[1], wire.nodes.length)];
      default:
        return invalid();
    }
  };
  const array = (a: unknown): unknown[] => (Array.isArray(a) ? a : invalid());
  const pairs = (a: unknown): unknown[][] =>
    array(a).map(p => {
      if (!Array.isArray(p) || p.length !== 2) {
        return invalid();
      }
      return p;
    });
  const nodes = wire.nodes.map(record => {
    if (!Array.isArray(record) || record.length !== 2) {
      return invalid();
    }
    const kind = kinds[index(record[0], kinds.length)]!;
    let data: unknown = record[1];
    switch (kind) {
      case 'object':
      case 'value-map':
      case 'core-map': {
        const seen = new Set<string>();
        data = pairs(data).map(([key, value]) => {
          const name = kind === 'object' ? keys[index(key, keys.length)]! : key;
          if (typeof name !== 'string' || seen.has(name)) {
            return invalid();
          }
          seen.add(name);
          return [name, atom(value)];
        });
        break;
      }
      case 'map':
        data = pairs(data).map(([key, value]) => [atom(key), atom(value)]);
        break;
      case 'array':
      case 'set':
      case 'list':
        data = array(data).map(atom);
        break;
      case 'run':
      case 'error':
      case 'object-value':
      case 'function':
        data = atom(data);
        break;
      case 'bytes':
        if (
          array(data).some(
            n =>
              typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255,
          )
        ) {
          invalid();
        }
        break;
      case 'abort':
        if (typeof data !== 'boolean') {
          invalid();
        }
        break;
      case 'value':
      case 'pattern':
        if (typeof data !== 'string') {
          invalid();
        }
        break;
    }
    return { kind, data };
  });
  return { nodes, root: atom(wire.root) };
};
