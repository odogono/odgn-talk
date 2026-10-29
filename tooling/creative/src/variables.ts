// The Variables window's data (#1141): the worker reads the showing Page's
// Script Variables into plain values, and the page turns them into rows.
// Nothing here touches the DOM.
import type { DeepReadonly } from './readonly';
import { isReadable, sourceForm } from '@northtalk/ts/debug';
import { text, type Value } from '@northtalk/ts';
import type { Element } from './model';
import type { PlaySession } from './play';

/** How many items of a list or map are sent and shown. */
export const ITEM_LIMIT = 100;

/**
 * A Script Variable's value as it crosses to the page. Lists and maps carry
 * their first `ITEM_LIMIT` items and their full length, and a cut-off one
 * that is readable carries its whole source form. An Element carries its
 * live name and, if authored, its place in `scriptOwners(project)`.
 */
export type VariableValue =
  | { kind: 'plain'; text: string }
  | {
      items: VariableValue[];
      kind: 'list';
      length: number;
      source?: string;
    }
  | {
      entries: [string, VariableValue][];
      kind: 'map';
      length: number;
      source?: string;
    }
  | {
      host: string;
      id: string;
      kind: 'object';
      live?: boolean;
      name?: string;
      owner?: number;
    }
  | { kind: 'function' };

/** One Script's variables, labelled by its owner as the Errors window does. */
export type VariableScript = {
  label: string;
  script: string;
  vars: [string, VariableValue][];
};

// As `sourceForm` writes a map key.
const sourceKey = (key: string): string =>
  key !== 'offer' && /^[A-Z_a-z]\w*$/.test(key) ? key : sourceForm(text(key));

// A cut-off list or map carries its whole source form, if it has one.
const wholeSource = (value: Value, length: number): { source?: string } =>
  length > ITEM_LIMIT && isReadable(value) ? { source: sourceForm(value) } : {};

const encode = (
  value: Value,
  element: (value: Value) => VariableValue | undefined,
): VariableValue => {
  switch (value.kind) {
    case 'list': {
      const items: VariableValue[] = [];
      for (let i = 1; i <= Math.min(value.length, ITEM_LIMIT); i++) {
        items.push(encode(value.index(i), element));
      }
      return {
        kind: 'list',
        items,
        length: value.length,
        ...wholeSource(value, value.length),
      };
    }
    case 'map': {
      const all = value.entries();
      return {
        kind: 'map',
        entries: all
          .slice(0, ITEM_LIMIT)
          .map(([key, entry]) => [sourceKey(key), encode(entry, element)]),
        length: all.length,
        ...wholeSource(value, all.length),
      };
    }
    case 'function':
      return { kind: 'function' };
    case 'object': {
      const ref = value.asObjectRef()!;
      return element(value) ?? { kind: 'object', host: ref.kind, id: ref.id };
    }
    default:
      return { kind: 'plain', text: sourceForm(value) };
  }
};

const isElement = (owner: object): owner is DeepReadonly<Element> =>
  !('pages' in owner) && !('elements' in owner);

/**
 * The Script Variables of the Project's Script, the showing Page's Script
 * and its Elements' Scripts, in that order, leaving out Scripts without
 * any. `owners` places authored owners in `scriptOwners(project)`.
 */
/** Encodes a value as the window shows it; `owners` as for `variablesOf`. */
export const valueEncoder = (
  play: PlaySession,
  owners: ReadonlyMap<unknown, number>,
): ((value: Value) => VariableValue) => {
  const element = (value: Value): VariableValue | undefined => {
    const object = value.asObject();
    const native = object?.native as DeepReadonly<Element> | undefined;
    if (
      !native ||
      typeof native !== 'object' ||
      play.objects.get(native) !== object ||
      !isElement(native)
    ) {
      return undefined;
    }
    const ref = value.asObjectRef()!;
    const owner = owners.get(play.authored.get(native) ?? native);
    return {
      kind: 'object',
      host: ref.kind,
      id: ref.id,
      name: native.name,
      live: play.pageIndexOf(native) >= 0,
      ...(owner === undefined ? {} : { owner }),
    };
  };
  return value => encode(value, element);
};

export const variablesOf = (
  play: PlaySession,
  owners: ReadonlyMap<unknown, number>,
): VariableScript[] => {
  const vars = new Map(
    play.group.inspect().scripts.map(script => [script.name, script.vars]),
  );
  const encodeValue = valueEncoder(play, owners);
  const ranked: [number, VariableScript][] = [];
  for (const [script, owner] of play.owners) {
    const rank =
      owner === play.project
        ? 0
        : owner === play.page
          ? 1
          : isElement(owner) && play.pageIndexOf(owner) === play.pageIndex
            ? 2
            : undefined;
    const found = vars.get(script);
    if (rank === undefined || !found?.length) {
      continue;
    }
    ranked.push([
      rank,
      {
        script,
        label:
          rank === 0
            ? 'Project'
            : rank === 1
              ? owner.name
              : `${play.page.name} › ${owner.name}`,
        vars: found.map(([name, value]) => [name, encodeValue(value)]),
      },
    ]);
  }
  // A stable sort keeps the Elements in load order.
  return ranked.sort(([a], [b]) => a - b).map(([, script]) => script);
};

/** A Watch as the page keeps it; `target` is a Message Box target's id. */
export type Watch = { id: number; target?: number; text: string };

/**
 * A Watch's latest evaluation. `effects` is set when its Run caused other
 * Runs, as a message it sent does (ADR 0129).
 */
export type WatchResult =
  | { effects: boolean; id: number; state: 'value'; value: VariableValue }
  | { id: number; state: 'waiting' }
  | { error: string; id: number; state: 'error' }
  | { id: number; state: 'unavailable' };

/** A row the window draws; `depth` 0 is a variable. */
export type VariableRow = {
  depth: number;
  /** Whether a list or map row is open; absent for other values. */
  expanded?: boolean;
  key: string;
  label: string;
  /** Set on the "… N more" row after a list's or map's shown items. */
  more?: number;
  value?: VariableValue;
};

/** A row's key: its Script, variable and path, kept across refreshes. */
export const rowKey = (script: string, path: readonly string[]): string =>
  JSON.stringify([script, ...path]);

/** How a value reads in its row; a list or map gives only its size. */
export const summary = (value: VariableValue): string => {
  switch (value.kind) {
    case 'plain':
      return value.text;
    case 'list':
      return `list of ${value.length}`;
    case 'map':
      return `map of ${value.length}`;
    case 'function':
      return 'function';
    case 'object':
      return value.name === undefined
        ? `${value.host} ${value.id}`
        : value.live
          ? value.name
          : '(deleted)';
  }
};

/**
 * A value's source form, which reads back as an equal value, or undefined
 * when it holds a Function Value or Host Object.
 */
export const sourceOf = (value: VariableValue): string | undefined => {
  switch (value.kind) {
    case 'plain':
      return value.text;
    case 'function':
    case 'object':
      return undefined;
    case 'list':
    case 'map': {
      if (value.source !== undefined) {
        return value.source;
      }
      // Cut off and unreadable.
      const shown =
        value.kind === 'list' ? value.items.length : value.entries.length;
      if (value.length > shown) {
        return undefined;
      }
      const parts: string[] = [];
      for (const [key, item] of childrenOf(value)) {
        const part = sourceOf(item);
        if (part === undefined) {
          return undefined;
        }
        parts.push(value.kind === 'list' ? part : `${key}: ${part}`);
      }
      return value.kind === 'list'
        ? `[${parts.join(', ')}]`
        : `{${parts.join(', ')}}`;
    }
  }
};

/** A list's or map's shown items, labelled by index or key. */
const childrenOf = (value: VariableValue): [string, VariableValue][] =>
  value.kind === 'list'
    ? value.items.map((item, i) => [String(i + 1), item])
    : value.kind === 'map'
      ? value.entries
      : [];

/** A Script's rows, opening the lists and maps whose keys are in `expanded`. */
export const variableRows = (
  script: VariableScript,
  expanded: ReadonlySet<string>,
): VariableRow[] => {
  const rows: VariableRow[] = [];
  const add = (
    label: string,
    value: VariableValue,
    path: string[],
    depth: number,
  ) => {
    const key = rowKey(script.script, path);
    const container = value.kind === 'list' || value.kind === 'map';
    const open = container && expanded.has(key);
    rows.push({
      key,
      label,
      value,
      depth,
      ...(container ? { expanded: open } : {}),
    });
    if (!open) {
      return;
    }
    const children = childrenOf(value);
    for (const [child, item] of children) {
      add(child, item, [...path, child], depth + 1);
    }
    const length =
      value.kind === 'list' || value.kind === 'map' ? value.length : 0;
    if (length > children.length) {
      rows.push({
        key: rowKey(script.script, [...path, '…']),
        label: '',
        depth: depth + 1,
        more: length - children.length,
      });
    }
  };
  for (const [name, value] of script.vars) {
    add(name, value, [name], 0);
  }
  return rows;
};

/** Each row's value as last refreshed, to tell which changed. */
export const rowValues = (
  scripts: readonly VariableScript[],
): Map<string, string> => {
  const values = new Map<string, string>();
  const walk = (script: string, path: string[], value: VariableValue) => {
    values.set(rowKey(script, path), JSON.stringify(value));
    const children = childrenOf(value);
    for (const [child, item] of children) {
      walk(script, [...path, child], item);
    }
  };
  for (const { script, vars } of scripts) {
    for (const [name, value] of vars) {
      walk(script, [name], value);
    }
  }
  return values;
};
