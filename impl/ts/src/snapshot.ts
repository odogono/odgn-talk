// Same-Core plain-data snapshots. The graph keeps shared frames, ballots and
// Join state shared, while executable code and Host objects are rebound by id.
import { HostError, ScriptError } from './errors';
import { encodeValue } from './encoding';
import { decodeValue } from './readers';
import {
  functionValue,
  listValues,
  map,
  nothing,
  Value,
  type FunctionRef,
} from './values';
import { stateOf } from './objects';
import { Run, coreRaised, loadScript } from './machine';
import { checkSource } from './checker';
import { lowerTree } from './lowering';
import { codeDoc } from './documentation';
import { functionHead } from './code-unit';

export const saveFormatVersion = 6;

type Atom = boolean | number | string | null | [string, (string | number)?];
type Node = { data: unknown; kind: string };
export type Graph = { nodes: Node[]; root: Atom };
export type References = {
  byKey: Map<string, object>;
  byObject: Map<object, string>;
};
export const references = (): References => ({
  byKey: new Map(),
  byObject: new Map(),
});
export const reference = (refs: References, key: string, value: object) => {
  refs.byKey.set(key, value);
  refs.byObject.set(value, key);
};

const staleCode = (code: unknown) => ({
  home: { live: false },
  doc: codeDoc(code),
  head: functionHead(code),
});

export const saveGraph = (root: unknown, refs: References): Graph => {
  const nodes: Node[] = [];
  const pending: object[] = [];
  const seen = new Map<object, number>();
  const atom = (v: unknown): Atom => {
    if (v === undefined) {
      return ['undefined'];
    }
    if (typeof v === 'bigint') {
      return ['bigint', String(v)];
    }
    if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'boolean' ||
      typeof v === 'number'
    ) {
      return v;
    }
    if (typeof v !== 'object') {
      throw new Error('A save contains executable state');
    }
    const key = refs.byObject.get(v);
    if (key !== undefined) {
      return ['external', key];
    }
    let index = seen.get(v);
    if (index === undefined) {
      index = nodes.length;
      seen.set(v, index);
      pending.push(v);
      nodes.push({ kind: '', data: null });
    }
    return ['ref', index];
  };
  const encoded = atom(root);
  for (let i = 0; i < pending.length; i++) {
    const v = pending[i]!;
    let kind = 'object';
    let data: unknown;
    if (Value.isValue(v)) {
      if (v.kind === 'pattern') {
        kind = 'pattern';
        data = v.patternSource();
      } else if (v.kind === 'object') {
        kind = 'object-value';
        data = atom(stateOf(v));
      } else if (v.kind === 'function') {
        kind = 'function';
        const fn = v.asFunction()!;
        const code = fn.code as { home: { live: boolean } };
        data = atom({
          ...fn,
          // Keep the original head before variables-only restore can rebind
          // body references to a changed Library's code.
          code: code.home.live
            ? { ...(fn.code as object), head: functionHead(fn.code) }
            : staleCode(fn.code),
        });
      } else if (v.kind === 'list') {
        kind = 'list';
        data = Array.from({ length: v.length }, (_, j) => atom(v.index(j + 1)));
      } else if (v.kind === 'map') {
        kind = coreRaised.has(v) ? 'core-map' : 'value-map';
        data = v.entries().map(([k, item]) => [k, atom(item)]);
      } else {
        kind = 'value';
        data = encodeValue(v);
      }
    } else if (Object.getPrototypeOf(v) === Run.prototype) {
      kind = 'run';
      data = atom((v as Run).snapshot());
    } else if (v instanceof ScriptError) {
      kind = 'error';
      data = atom({ code: v.code, message: v.message, data: v.data });
    } else if (Object.getPrototypeOf(v) === AbortController.prototype) {
      kind = 'abort';
      data = (v as AbortController).signal.aborted;
    } else if (Object.getPrototypeOf(v) === Uint8Array.prototype) {
      kind = 'bytes';
      data = [...(v as Uint8Array)];
    } else if (Object.getPrototypeOf(v) === Map.prototype) {
      kind = 'map';
      data = [...(v as Map<unknown, unknown>)].map(([k, item]) => [
        atom(k),
        atom(item),
      ]);
    } else if (Object.getPrototypeOf(v) === Set.prototype) {
      kind = 'set';
      data = [...(v as Set<unknown>)].map(atom);
    } else if (Array.isArray(v)) {
      kind = 'array';
      data = v.map(atom);
    } else {
      if (
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null
      ) {
        throw new Error('Unsupported save state');
      }
      data = Object.entries(v)
        .filter(
          ([k]) =>
            !['request', 'unsubscribe', 'resolve', 'fire', 'apply'].includes(k),
        )
        .map(([k, item]) => [k, atom(item)]);
    }
    nodes[i] = { kind, data };
  }
  return { root: encoded, nodes };
};

export const restoreGraph = (
  graph: Graph,
  refs: References,
  variablesOnly = false,
): unknown => {
  // An explicit work stack keeps arbitrarily nested Host Values off the JS stack.
  const values: unknown[] = [];
  const seen = new Set<number>();
  const jobs: (() => void)[] = [];
  type Done = (value: unknown) => void;
  const many = (atoms: Atom[], done: (items: unknown[]) => void) => {
    if (!Array.isArray(atoms)) {
      invalid();
    }
    const items: unknown[] = new Array(atoms.length);
    jobs.push(() => done(items));
    for (let j = atoms.length - 1; j >= 0; j--) {
      jobs.push(() =>
        read(atoms[j]!, value => {
          items[j] = value;
        }),
      );
    }
  };
  const read = (a: Atom, done: Done): void => {
    if (!Array.isArray(a)) {
      if (a !== null && !['boolean', 'number', 'string'].includes(typeof a)) {
        invalid();
      }
      done(a);
      return;
    }
    switch (a[0]) {
      case 'undefined':
        done(undefined);
        return;
      case 'bigint':
        done(BigInt(a[1]!));
        return;
      case 'external':
        done(refs.byKey.get(String(a[1])) ?? (variablesOnly ? {} : invalid()));
        return;
      case 'ref':
        break;
      default:
        invalid();
    }
    const i = Number(a[1]);
    if (!Number.isSafeInteger(i) || i < 0) {
      invalid();
    }
    if (seen.has(i)) {
      if (values[i] === undefined) {
        invalid();
      } // Immutable Value cycles aren't legal.
      done(values[i]);
      return;
    }
    const n = graph.nodes[i] ?? invalid();
    seen.add(i);
    const finish = (value: unknown) => {
      values[i] = value;
      done(value);
    };
    const child = (a: Atom, finish: Done) => jobs.push(() => read(a, finish));
    switch (n.kind) {
      case 'object-value':
        child(n.data as Atom, v =>
          finish((v as import('./objects').ObjectState).handle.value),
        );
        break;
      case 'pattern': {
        if (typeof n.data !== 'string') {
          invalid();
        }
        const checked = checkSource(
          `script variable savedPattern = ${n.data as string}`,
        );
        if (!checked.ok || !checked.tree) {
          invalid();
        }
        finish(
          loadScript(lowerTree(checked.tree!, { name: 'saved-pattern' }), {
            patternSize: Number.MAX_SAFE_INTEGER,
          }).variables[0]!,
        );
        break;
      }
      case 'value':
        finish(decodeValue(n.data as string));
        break;
      case 'function':
        child(n.data as Atom, v => {
          const fn = v as FunctionRef;
          const head = functionHead(fn.code);
          if (
            !head ||
            (head.name !== null && typeof head.name !== 'string') ||
            !Number.isSafeInteger(head.min) ||
            !Number.isSafeInteger(head.max) ||
            head.min < 0 ||
            head.max < head.min
          ) {
            invalid();
          }
          finish(
            functionValue(
              variablesOnly
                ? {
                    ...fn,
                    code: staleCode(fn.code),
                  }
                : fn,
            ),
          );
        });
        break;
      case 'list':
        many(n.data as Atom[], items => finish(listValues(items as Value[])));
        break;
      case 'core-map':
      case 'value-map': {
        const pairs = n.data as [string, Atom][];
        many(
          pairs.map(p => p[1]),
          items => {
            const value = map(
              pairs.map(([key], j) => [key, items[j] as Value]),
            );
            if (n.kind === 'core-map') {
              coreRaised.add(value);
            }
            finish(value);
          },
        );
        break;
      }
      case 'bytes':
        finish(Uint8Array.from(n.data as number[]));
        break;
      case 'abort': {
        const abort = new AbortController();
        if (n.data) {
          abort.abort();
        }
        finish(abort);
        break;
      }
      case 'error':
        child(n.data as Atom, v => {
          const e = v as { code: string; data: unknown; message: string };
          // A save from before Host errors had Value data holds null.
          finish(
            new ScriptError(
              e.code,
              e.message,
              Value.isValue(e.data) ? e.data : nothing,
            ),
          );
        });
        break;
      case 'run': {
        const run = Run.empty();
        values[i] = run;
        child(n.data as Atom, v => {
          run.restore(v as Record<string, unknown>);
          finish(run);
        });
        break;
      }
      case 'array': {
        const out: unknown[] = [];
        values[i] = out;
        many(n.data as Atom[], items => {
          for (const item of items) {
            out.push(item);
          }
          finish(out);
        });
        break;
      }
      case 'map': {
        const out = new Map();
        values[i] = out;
        const pairs = n.data as [Atom, Atom][];
        many(pairs.flat(), items => {
          for (let j = 0; j < items.length; j += 2) {
            out.set(items[j], items[j + 1]);
          }
          finish(out);
        });
        break;
      }
      case 'set': {
        const out = new Set();
        values[i] = out;
        many(n.data as Atom[], items => {
          for (const item of items) {
            out.add(item);
          }
          finish(out);
        });
        break;
      }
      case 'object': {
        const out: Record<string, unknown> = {};
        values[i] = out;
        const pairs = n.data as [string, Atom][];
        many(
          pairs.map(p => p[1]),
          items => {
            pairs.forEach(([key], j) => {
              if (['__proto__', 'constructor', 'prototype'].includes(key)) {
                invalid();
              }
              out[key] = items[j];
            });
            finish(out);
          },
        );
        break;
      }
      default:
        invalid();
    }
  };
  try {
    let root: unknown;
    read(graph.root, value => {
      root = value;
    });
    while (jobs.length) {
      jobs.pop()!();
    }
    return root;
  } catch {
    return invalid();
  }
};

const invalid = (): never => {
  throw new HostError('invalid save');
};
