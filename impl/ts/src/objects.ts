// Chapter 9's Host Objects: Object Kinds with their properties, defined once
// per process, and the Group-scoped handles a Host makes, whose parents,
// disposal and Owning Script the Core holds (ADR 0016).
import type { CheckOptions } from './checker';
import type { Cost, Shape } from './capabilities';
import { HostError } from './errors';
import { objectValue, type Value } from './values';

export type PropDef<N> = {
  get(o: HostObject<N>): Value;
  getCost?: Cost;
  /** Omit for read-only. Throw ScriptError to refuse. */
  set?(o: HostObject<N>, v: Value): void;
  setCost?: Cost;
  shape?: Shape;
};
/**
 * An Object Kind's ordered, named collection of Host Objects (#1143). Its
 * callbacks are synchronous and read-only, like a property's `get`; `at`
 * gets a nonzero index, negative from the end.
 */
export type ObjectElements<N> = {
  at(o: HostObject<N>, index: number): Value;
  atCost: Cost;
  count(o: HostObject<N>): Value;
  countCost: Cost;
  find(o: HostObject<N>, name: string): Value;
  findCost: Cost;
  shape: Shape;
};
export type ObjectKindDef<N> = {
  /** Omit for a kind with no collection. */
  elements?: ObjectElements<N>;
  name: string;
  /** For the Host Manifest only; `setParent` doesn't check it. */
  parentKinds?: string[];
  props: Record<string, PropDef<N>>;
};
export type ObjectKind<N = unknown> = {
  readonly elements: Readonly<ObjectElements<N>> | null;
  readonly name: string;
  readonly parentKinds: readonly string[];
  readonly props: ReadonlyMap<string, PropDef<N>>;
};

// A declared cost: whole Fuel and allocation in the safe-integer range.
const elementCost = (cost: unknown, name: string): Cost => {
  const c = cost as Cost | undefined;
  if (
    !c ||
    typeof c !== 'object' ||
    !Number.isSafeInteger(c.fuel) ||
    c.fuel < 0 ||
    (c.alloc !== undefined && (!Number.isSafeInteger(c.alloc) || c.alloc < 0))
  ) {
    throw new HostError('invalid value', `Invalid or missing elements ${name}`);
  }
  return Object.freeze({
    fuel: c.fuel,
    ...(c.alloc === undefined ? {} : { alloc: c.alloc }),
  });
};

// An Object Shape, or a nonempty choice of Object Shapes of distinct kinds.
const elementShape = (shape: unknown): Shape => {
  const s = shape as Shape | undefined;
  const kinds =
    s?.k === 'object'
      ? [s.kind]
      : s?.k === 'oneOf' && s.of.length && s.of.every(o => o.k === 'object')
        ? s.of.map(o => (o as { kind: string }).kind)
        : null;
  if (!kinds || new Set(kinds).size !== kinds.length) {
    throw new HostError(
      'invalid value',
      'An Object Collection Shape must be an Object Shape or a choice of distinct ones',
    );
  }
  return s!;
};

const objectElements = <N>(
  e: ObjectElements<N> | undefined,
): Readonly<ObjectElements<N>> | null => {
  if (e === undefined) {
    return null;
  }
  if (
    !e ||
    typeof e.count !== 'function' ||
    typeof e.at !== 'function' ||
    typeof e.find !== 'function'
  ) {
    throw new HostError(
      'invalid value',
      'An Object Collection needs count, at and find',
    );
  }
  return Object.freeze({
    shape: elementShape(e.shape),
    count: e.count,
    at: e.at,
    find: e.find,
    countCost: elementCost(e.countCost, 'countCost'),
    atCost: elementCost(e.atCost, 'atCost'),
    findCost: elementCost(e.findCost, 'findCost'),
  });
};

const kinds = new Map<string, ObjectKind>();
/** A restored handle uses the process's definition of its saved kind. */
export const objectKind = (name: string): ObjectKind | undefined =>
  kinds.get(name);

/** Define an Object Kind, once per process. */
export const defineObjectKind = <N>(k: ObjectKindDef<N>): ObjectKind<N> => {
  const kind = Object.freeze({
    name: k.name,
    parentKinds: Object.freeze([...(k.parentKinds ?? [])]),
    props: new Map(Object.entries(k.props)),
    elements: objectElements(k.elements),
  });
  kinds.set(kind.name, kind as ObjectKind);
  return kind;
};

/** A Group-scoped handle to something the Host owns. */
export type HostObject<N = unknown> = {
  readonly id: string;
  readonly kind: ObjectKind<N>;
  readonly native: N;
  readonly value: Value;
};

/** What the Group holds for each of its objects (chapter 9, Host Objects). */
export type ObjectState = {
  disposed: boolean;
  handle: HostObject;
  /** The Script that owns it, by name. */
  owner: string | null;
  parent: ObjectState | null;
};

/** A new handle and its state, for the Group that makes it. */
export const makeObject = <N>(
  kind: ObjectKind<N>,
  id: string,
  native: N,
): ObjectState => {
  const state = {} as ObjectState;
  const handle: HostObject<N> = Object.freeze({
    id,
    kind,
    native,
    value: objectValue({ kind: kind.name, id, handle: state }),
  });
  Object.assign(state, {
    disposed: false,
    handle,
    owner: null,
    parent: null,
  });
  return state;
};

/** The Group's state of an object value. */
export const stateOf = (v: Value): ObjectState | undefined =>
  v.asObjectRef()?.handle as ObjectState | undefined;

/** Rebind native state while preserving every saved reference to this object. */
export const rebindObject = (state: ObjectState, native: unknown): void => {
  const { kind, id } = state.handle;
  state.handle = Object.freeze({
    kind,
    id,
    native,
    value: objectValue({ kind: kind.name, id, handle: state }),
  });
};

/** Loading checks declarations without retaining Host callbacks in checked code. */
export const propertyChecks = (
  objects: Readonly<Record<string, HostObject>>,
  owner?: HostObject,
): Pick<CheckOptions, 'objectProperties' | 'ownerProperties'> => {
  const props = (kind: ObjectKind) =>
    Object.fromEntries(
      [...kind.props].map(([name, prop]) => [name, !!prop.set]),
    );
  return {
    objectProperties: Object.fromEntries(
      Object.entries(objects).map(([name, object]) => [
        name,
        props(object.kind),
      ]),
    ),
    ownerProperties: owner ? props(owner.kind) : undefined,
  };
};
