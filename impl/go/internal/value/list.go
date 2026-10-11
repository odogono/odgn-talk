package value

import (
	"slices"
	"sync/atomic"
)

const listChunkSize = 32

// A List is a persistent AVL sequence of small chunks. Published chunks and
// nodes are immutable, so updates and branched growth copy only a tree path.
// Appends fill a shared tail chunk outside the tree: the first view to extend
// a tail claims its next slot in place, and a later branch copies the tail.
// The tree path is therefore copied once per chunk instead of once per append.
// Legacy contiguous reads materialize once; machine point operations use
// ListLen and ListAt without flattening the collection.
type listView struct {
	root        *tree[int, []Value]
	first, last int
	tail        *listTail
	tailLen     int
	items       atomic.Pointer[[]Value] // Materialized contiguous items.
	contents    atomic.Int64            // Logical contents size + 1; zero means unmeasured.
}

// listTail slots below a view's tailLen never change; used is the number of
// claimed slots, so only one view may write each slot.
type listTail struct {
	items [listChunkSize]Value
	used  atomic.Int64
}

func NewList(vs []Value) Value {
	view := &listView{last: -1}
	for i := 0; i < len(vs); i += listChunkSize {
		chunk := slices.Clone(vs[i:min(i+listChunkSize, len(vs))])
		view.last++
		view.root = treePut(view.root, view.last, chunk, len(chunk))
	}
	return Value{Kind: List, data: view}
}

// sealed returns the view's tree with its tail stored as the last chunk.
func (view *listView) sealed() (*tree[int, []Value], int, int) {
	root, first, last := view.root, view.first, view.last
	if view.tailLen > 0 {
		last++
		if root == nil {
			first = last
		}
		root = treePut(root, last, view.tail.items[:view.tailLen:view.tailLen], view.tailLen)
	}
	return root, first, last
}
func (v Value) view() *listView { x, _ := v.data.(*listView); return x }
func (v Value) ListLen() int {
	if view := v.view(); view != nil {
		return treeTotal(view.root) + view.tailLen
	}
	return len(v.Items())
}
func (v Value) ListAt(i int) Value {
	if view := v.view(); view != nil {
		n, at := treeAt(view.root, i)
		if n != nil {
			return n.val[at]
		}
		if i -= treeTotal(view.root); i >= 0 && i < view.tailLen {
			return view.tail.items[i]
		}
		return Value{}
	}
	if i >= 0 && i < len(v.Items()) {
		return v.Items()[i]
	}
	return Value{}
}

// SetListItem replaces or deletes one existing item (zero-based).
func (v Value) SetListItem(i int, part Value, deleting bool) Value {
	if v.view() == nil {
		v = NewList(v.Items())
	}
	view := v.view()
	if view.tailLen > 0 {
		root, first, last := view.sealed()
		view = &listView{root: root, first: first, last: last}
	}
	n, at := treeAt(view.root, i)
	chunk := slices.Clone(n.val)
	if deleting {
		chunk = slices.Delete(chunk, at, at+1)
	} else {
		chunk[at] = part
	}
	root := view.root
	if len(chunk) == 0 {
		root = treeRemove(root, n.key)
	} else {
		root = treePut(root, n.key, chunk, len(chunk))
	}
	next := &listView{root: root, last: -1}
	if first, _ := treeAt(root, 0); first != nil {
		next.first = first.key
	}
	if last, _ := treeAt(root, treeTotal(root)-1); last != nil {
		next.last = last.key
	}
	return Value{Kind: List, CoreMessage: v.CoreMessage, data: next}
}
func (v Value) ExtendList(vs []Value, prepend bool) Value {
	if len(vs) == 0 {
		return v
	}
	if v.view() == nil {
		v = NewList(v.Items())
	}
	if !prepend {
		return v.appendList(vs)
	}
	root, first, last := v.view().sealed()
	done := 0
	if edge, _ := treeAt(root, 0); edge != nil && edge.span < listChunkSize {
		n := min(len(vs), listChunkSize-edge.span)
		chunk := make([]Value, 0, edge.span+n)
		chunk = append(chunk, vs[len(vs)-n:]...)
		chunk = append(chunk, edge.val...)
		root = treePut(root, edge.key, chunk, len(chunk))
		done = n
	}
	for done < len(vs) {
		n := min(listChunkSize, len(vs)-done)
		start := len(vs) - done - n
		key := 0
		if root != nil {
			key = first - 1
		}
		root = treePut(root, key, slices.Clone(vs[start:start+n]), n)
		first = key
		if treeTotal(root) == n {
			last = key
		}
		done += n
	}
	return Value{Kind: List, CoreMessage: v.CoreMessage, data: &listView{root: root, first: first, last: last}}
}

func (v Value) appendList(vs []Value) Value {
	view := v.view()
	root, first, last, tail, n := view.root, view.first, view.last, view.tail, view.tailLen
	if tail == nil {
		// Reopen a partial last chunk so alternating ends keep chunks full.
		tail = &listTail{}
		if edge, _ := treeAt(root, treeTotal(root)-1); edge != nil && edge.span < listChunkSize {
			n = copy(tail.items[:], edge.val)
			root, last = treeRemove(root, edge.key), edge.key-1
		}
		tail.used.Store(int64(n))
	}
	for _, item := range vs {
		if n == listChunkSize {
			last++
			if root == nil {
				first = last
			}
			root = treePut(root, last, tail.items[:], n)
			tail, n = &listTail{}, 0
		} else if !tail.used.CompareAndSwap(int64(n), int64(n+1)) {
			// Another branch claimed this slot; copy the shared prefix.
			branch := &listTail{}
			copy(branch.items[:], tail.items[:n])
			branch.used.Store(int64(n + 1))
			tail = branch
		} else {
			tail.items[n] = item
			n++
			continue
		}
		if n == 0 {
			tail.used.Store(1)
		}
		tail.items[n] = item
		n++
	}
	return Value{Kind: List, CoreMessage: v.CoreMessage, data: &listView{root: root, first: first, last: last, tail: tail, tailLen: n}}
}

// ListContents counts every logical child, even when chunks are shared.
func (v Value) ListContents(size func(Value) int64) int64 {
	view := v.view()
	if view != nil {
		if cached := view.contents.Load(); cached != 0 {
			return cached - 1
		}
	}
	var total int64
	if view != nil {
		treeWalk(view.root, func(chunk []Value) {
			for _, item := range chunk {
				total += size(item)
			}
		})
		for _, item := range view.tail.prefix(view.tailLen) {
			total += size(item)
		}
	} else {
		for _, item := range v.Items() {
			total += size(item)
		}
	}
	v.CacheListContents(total)
	return total
}
func (v Value) CacheListContents(contents int64) {
	if view := v.view(); view != nil {
		view.contents.Store(contents + 1)
	}
}

func (tail *listTail) prefix(n int) []Value {
	if tail == nil {
		return nil
	}
	return tail.items[:n]
}
