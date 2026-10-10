package value

import (
	"slices"
	"sync"
	"sync/atomic"
)

const listChunkSize = 32

// A List is a persistent AVL sequence of small chunks. Published chunks and
// nodes are immutable, so updates and branched growth copy only a tree path.
// Legacy contiguous reads materialize once; machine point operations use
// ListLen and ListAt without flattening the collection.
type listView struct {
	root        *tree[int, []Value]
	first, last int
	once        sync.Once
	items       []Value
	contents    atomic.Int64 // Logical contents size + 1; zero means unmeasured.
}

func NewList(vs []Value) Value {
	view := &listView{last: -1}
	for i := 0; i < len(vs); i += listChunkSize {
		chunk := slices.Clone(vs[i:min(i+listChunkSize, len(vs))])
		view.last++
		view.root = treePut(view.root, view.last, chunk, len(chunk))
	}
	return Value{Kind: List, list: view}
}
func (v Value) ListLen() int {
	if v.list != nil {
		return treeTotal(v.list.root)
	}
	return len(v.Items())
}
func (v Value) ListAt(i int) Value {
	if v.list != nil {
		n, at := treeAt(v.list.root, i)
		if n != nil {
			return n.val[at]
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
	if v.list == nil {
		v = NewList(v.Items())
	}
	view := v.list
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
	return Value{Kind: List, CoreMessage: v.CoreMessage, list: next}
}
func (v Value) ExtendList(vs []Value, prepend bool) Value {
	if len(vs) == 0 {
		return v
	}
	if v.list == nil {
		v = NewList(v.Items())
	}
	view := v.list
	root, first, last := view.root, view.first, view.last
	done := 0
	position := treeTotal(root) - 1
	if prepend {
		position = 0
	}
	if edge, _ := treeAt(root, position); edge != nil && edge.span < listChunkSize {
		n := min(len(vs), listChunkSize-edge.span)
		chunk := make([]Value, 0, edge.span+n)
		if prepend {
			chunk = append(chunk, vs[len(vs)-n:]...)
			chunk = append(chunk, edge.val...)
		} else {
			chunk = append(chunk, edge.val...)
			chunk = append(chunk, vs[:n]...)
		}
		root = treePut(root, edge.key, chunk, len(chunk))
		done = n
	}
	for done < len(vs) {
		n := min(listChunkSize, len(vs)-done)
		start := done
		if prepend {
			start = len(vs) - done - n
		}
		chunk := slices.Clone(vs[start : start+n])
		key := 0
		if root != nil {
			if prepend {
				key = first - 1
			} else {
				key = last + 1
			}
		}
		root = treePut(root, key, chunk, n)
		if prepend || treeTotal(root) == n {
			first = key
		}
		if !prepend || treeTotal(root) == n {
			last = key
		}
		done += n
	}
	return Value{Kind: List, CoreMessage: v.CoreMessage, list: &listView{root: root, first: first, last: last}}
}

// ListContents counts every logical child, even when chunks are shared.
func (v Value) ListContents(size func(Value) int64) int64 {
	if v.list != nil {
		if cached := v.list.contents.Load(); cached != 0 {
			return cached - 1
		}
	}
	var total int64
	if v.list != nil {
		treeWalk(v.list.root, func(chunk []Value) {
			for _, item := range chunk {
				total += size(item)
			}
		})
	} else {
		for _, item := range v.Items() {
			total += size(item)
		}
	}
	v.CacheListContents(total)
	return total
}
func (v Value) CacheListContents(contents int64) {
	if v.list != nil {
		v.list.contents.Store(contents + 1)
	}
}
