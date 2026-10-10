package value

import "cmp"

// tree is an immutable AVL tree. span is the number of sequence slots in this
// node, allowing Lists to store chunks instead of one wide node per Value.
type tree[K cmp.Ordered, V any] struct {
	key                 K
	val                 V
	left, right         *tree[K, V]
	height, span, total int
}

func treeHeight[K cmp.Ordered, V any](t *tree[K, V]) int {
	if t == nil {
		return 0
	}
	return t.height
}
func treeTotal[K cmp.Ordered, V any](t *tree[K, V]) int {
	if t == nil {
		return 0
	}
	return t.total
}
func treeNode[K cmp.Ordered, V any](key K, val V, span int, left, right *tree[K, V]) *tree[K, V] {
	return &tree[K, V]{key: key, val: val, span: span, left: left, right: right, height: 1 + max(treeHeight(left), treeHeight(right)), total: span + treeTotal(left) + treeTotal(right)}
}
func treeBalance[K cmp.Ordered, V any](key K, val V, span int, left, right *tree[K, V]) *tree[K, V] {
	if treeHeight(left) > treeHeight(right)+1 {
		l := left
		if treeHeight(l.right) > treeHeight(l.left) {
			r := l.right
			l = treeNode(r.key, r.val, r.span, treeNode(l.key, l.val, l.span, l.left, r.left), r.right)
		}
		return treeNode(l.key, l.val, l.span, l.left, treeNode(key, val, span, l.right, right))
	}
	if treeHeight(right) > treeHeight(left)+1 {
		r := right
		if treeHeight(r.left) > treeHeight(r.right) {
			l := r.left
			r = treeNode(l.key, l.val, l.span, l.left, treeNode(r.key, r.val, r.span, l.right, r.right))
		}
		return treeNode(r.key, r.val, r.span, treeNode(key, val, span, left, r.left), r.right)
	}
	return treeNode(key, val, span, left, right)
}
func treeFind[K cmp.Ordered, V any](t *tree[K, V], key K) *tree[K, V] {
	for t != nil {
		if key == t.key {
			return t
		}
		if key < t.key {
			t = t.left
		} else {
			t = t.right
		}
	}
	return nil
}
func treePut[K cmp.Ordered, V any](t *tree[K, V], key K, val V, span int) *tree[K, V] {
	if t == nil {
		return treeNode(key, val, span, nil, nil)
	}
	if key == t.key {
		return treeNode(key, val, span, t.left, t.right)
	}
	if key < t.key {
		return treeBalance(t.key, t.val, t.span, treePut(t.left, key, val, span), t.right)
	}
	return treeBalance(t.key, t.val, t.span, t.left, treePut(t.right, key, val, span))
}
func treeRemove[K cmp.Ordered, V any](t *tree[K, V], key K) *tree[K, V] {
	if t == nil {
		return nil
	}
	if key < t.key {
		return treeBalance(t.key, t.val, t.span, treeRemove(t.left, key), t.right)
	}
	if key > t.key {
		return treeBalance(t.key, t.val, t.span, t.left, treeRemove(t.right, key))
	}
	if t.left == nil {
		return t.right
	}
	if t.right == nil {
		return t.left
	}
	next := t.right
	for next.left != nil {
		next = next.left
	}
	return treeBalance(next.key, next.val, next.span, t.left, treeRemove(t.right, next.key))
}
func treeAt[K cmp.Ordered, V any](t *tree[K, V], i int) (*tree[K, V], int) {
	if i < 0 || i >= treeTotal(t) {
		return nil, 0
	}
	for t != nil {
		left := treeTotal(t.left)
		if i < left {
			t = t.left
		} else if i < left+t.span {
			return t, i - left
		} else {
			i -= left + t.span
			t = t.right
		}
	}
	return nil, 0
}
func treeWalk[K cmp.Ordered, V any](t *tree[K, V], visit func(V)) {
	if t != nil {
		treeWalk(t.left, visit)
		visit(t.val)
		treeWalk(t.right, visit)
	}
}
