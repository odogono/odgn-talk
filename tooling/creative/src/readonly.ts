/**
 * A deeply readonly view of Folio's plain data objects, unions and arrays.
 * This is a TypeScript contract; it does not clone or freeze live data.
 */
export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

/** The writable counterpart of a readonly view; a type assertion only. */
export type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

/** A detached, writable deep copy of a readonly view. */
export const thaw = <T>(value: DeepReadonly<T>): T =>
  structuredClone(value) as T;
