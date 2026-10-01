// Chapter 9's Host Objects: Object Kinds with their properties, defined once
// per process, and the Group-scoped handles a Host makes, whose parents,
// disposal and Owning Script the Core holds (ADR 0016).
import type { Cost, Shape } from './capabilities';
import { objectValue, type Value } from './values';

export type PropDef<N> = {
  get(o: HostObject<N>): Value;
  getCost?: Cost;
  /** Omit for read-only. Throw ScriptError to refuse. */
  set?(o: HostObject<N>, v: Value): void;
  setCost?: Cost;
  shape?: Shape;
};
export type ObjectKindDef<N> = {
  name: string;
  /** For the Host Manifest only; `setParent` doesn't check it. */
  parentKinds?: string[];
  props: Record<string, PropDef<N>>;
};
export type ObjectKind<N = unknown> = {
  readonly name: string;
  readonly parentKinds: readonly string[];
  readonly props: ReadonlyMap<string, PropDef<N>>;
};

/** Define an Object Kind, once per process. */
export const defineObjectKind = <N>(k: ObjectKindDef<N>): ObjectKind<N> =>
  Object.freeze({
    name: k.name,
    parentKinds: Object.freeze([...(k.parentKinds ?? [])]),
    props: new Map(Object.entries(k.props)),
  });

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
