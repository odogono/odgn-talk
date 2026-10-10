/** Immutable AVL nodes. `span` lets a node hold a small sequence chunk. */
export type Tree<K extends string | number, V> = {
  readonly height: number;
  readonly key: K;
  readonly left: Tree<K, V> | undefined;
  readonly right: Tree<K, V> | undefined;
  readonly span: number;
  readonly total: number;
  readonly value: V;
};
export const total = <K extends string | number, V>(
  t: Tree<K, V> | undefined,
): number => t?.total ?? 0;
const height = <K extends string | number, V>(t: Tree<K, V> | undefined) =>
  t?.height ?? 0;
const node = <K extends string | number, V>(
  key: K,
  value: V,
  span: number,
  left?: Tree<K, V>,
  right?: Tree<K, V>,
): Tree<K, V> => ({
  key,
  value,
  span,
  left,
  right,
  height: 1 + Math.max(height(left), height(right)),
  total: span + total(left) + total(right),
});
const balance = <K extends string | number, V>(
  key: K,
  value: V,
  span: number,
  left?: Tree<K, V>,
  right?: Tree<K, V>,
): Tree<K, V> => {
  if (height(left) > height(right) + 1) {
    let l = left!;
    if (height(l.right) > height(l.left)) {
      const r = l.right!;
      l = node(
        r.key,
        r.value,
        r.span,
        node(l.key, l.value, l.span, l.left, r.left),
        r.right,
      );
    }
    return node(
      l.key,
      l.value,
      l.span,
      l.left,
      node(key, value, span, l.right, right),
    );
  }
  if (height(right) > height(left) + 1) {
    let r = right!;
    if (height(r.left) > height(r.right)) {
      const l = r.left!;
      r = node(
        l.key,
        l.value,
        l.span,
        l.left,
        node(r.key, r.value, r.span, l.right, r.right),
      );
    }
    return node(
      r.key,
      r.value,
      r.span,
      node(key, value, span, left, r.left),
      r.right,
    );
  }
  return node(key, value, span, left, right);
};
export const find = <K extends string | number, V>(
  t: Tree<K, V> | undefined,
  key: K,
): Tree<K, V> | undefined => {
  while (t) {
    if (key === t.key) {
      return t;
    }
    t = key < t.key ? t.left : t.right;
  }
  return undefined;
};
export const put = <K extends string | number, V>(
  t: Tree<K, V> | undefined,
  key: K,
  value: V,
  span = 1,
): Tree<K, V> => {
  if (!t) {
    return node(key, value, span);
  }
  if (key === t.key) {
    return node(key, value, span, t.left, t.right);
  }
  return key < t.key
    ? balance(t.key, t.value, t.span, put(t.left, key, value, span), t.right)
    : balance(t.key, t.value, t.span, t.left, put(t.right, key, value, span));
};
export const remove = <K extends string | number, V>(
  t: Tree<K, V> | undefined,
  key: K,
): Tree<K, V> | undefined => {
  if (!t) {
    return undefined;
  }
  if (key < t.key) {
    return balance(t.key, t.value, t.span, remove(t.left, key), t.right);
  }
  if (key > t.key) {
    return balance(t.key, t.value, t.span, t.left, remove(t.right, key));
  }
  if (!t.left) {
    return t.right;
  }
  if (!t.right) {
    return t.left;
  }
  let next = t.right;
  while (next.left) {
    next = next.left;
  }
  return balance(
    next.key,
    next.value,
    next.span,
    t.left,
    remove(t.right, next.key),
  );
};
/** Find an element by zero-based sequence position, returning its chunk offset. */
export const at = <K extends string | number, V>(
  t: Tree<K, V> | undefined,
  i: number,
): { node: Tree<K, V>; offset: number } | undefined => {
  if (i < 0 || i >= total(t)) {
    return undefined;
  }
  while (t) {
    const left = total(t.left);
    if (i < left) {
      t = t.left;
    } else if (i < left + t.span) {
      return { node: t, offset: i - left };
    } else {
      i -= left + t.span;
      t = t.right;
    }
  }
  return undefined;
};
export const values = function* <K extends string | number, V>(
  t: Tree<K, V> | undefined,
): Generator<V> {
  if (t) {
    yield* values(t.left);
    yield t.value;
    yield* values(t.right);
  }
};
