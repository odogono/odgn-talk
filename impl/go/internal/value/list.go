package value

import (
	"slices"
	"sync"
	"sync/atomic"
)

// A List publishes a fixed window. Growth writes only outside every published
// window; a branch whose end has already been extended gets a fresh buffer.
// Geometric capacity makes an unbranched sequence of appends/prepends linear.
// Items remains a contiguous, read-only view for the rest of the Core.
type listBuffer struct {
	mu         sync.Mutex // Values can be shared by concurrently pumped Groups.
	items      []Value
	start, end int // The union of all published windows in this buffer.
}

type listView struct {
	buffer     *listBuffer
	start, end int
	contents   atomic.Int64 // Logical contents size + 1; zero means unmeasured.
}

func NewList(vs []Value) Value {
	items := slices.Clone(vs)
	buffer := &listBuffer{items: items, end: len(items)}
	return listWindow(buffer, 0, len(items))
}

func listWindow(buffer *listBuffer, start, end int) Value {
	return Fields{Kind: List, Items: buffer.items[start:end:end], list: &listView{buffer: buffer, start: start, end: end}}.Value()
}

// Internal transformations sometimes replace Items on a copied Value. Such a
// detached slice cannot use the old window's storage or accounting cache.
func (v Value) listWindowValid() bool {
	return v.Kind == List && v.list != nil && len(v.Items()) == v.list.end-v.list.start &&
		(len(v.Items()) == 0 || &v.Items()[0] == &v.list.buffer.items[v.list.start])
}

// ExtendList retains every existing item, including those visible through
// aliases and Segment checkpoints. vs may itself share this List's buffer.
func (v Value) ExtendList(vs []Value, prepend bool) Value {
	if len(vs) == 0 {
		return v
	}
	if v.listWindowValid() {
		view, count := v.list, len(vs)
		buffer := view.buffer
		buffer.mu.Lock()
		if prepend && view.start == buffer.start && count <= view.start {
			start := view.start - count
			copy(buffer.items[start:view.start], vs)
			buffer.start = start
			buffer.mu.Unlock()
			return listWindow(buffer, start, view.end)
		}
		if !prepend && view.end == buffer.end && count <= len(buffer.items)-view.end {
			end := view.end + count
			copy(buffer.items[view.end:end], vs)
			buffer.end = end
			buffer.mu.Unlock()
			return listWindow(buffer, view.start, end)
		}
		buffer.mu.Unlock()
	}
	count := len(v.Items()) + len(vs)
	items := make([]Value, max(8, 2*count))
	start := (len(items) - count) / 2
	if prepend {
		copy(items[start:], vs)
		copy(items[start+len(vs):], v.Items())
	} else {
		copy(items[start:], v.Items())
		copy(items[start+len(v.Items()):], vs)
	}
	buffer := &listBuffer{items: items, start: start, end: start + count}
	return listWindow(buffer, start, start+count)
}

// ListContents memoizes the sum of item sizes, as if no storage were shared.
// The machine supplies the current Cost Model's size function.
func (v Value) ListContents(size func(Value) int64) int64 {
	valid := v.listWindowValid()
	if valid {
		if cached := v.list.contents.Load(); cached != 0 {
			return cached - 1
		}
	}
	var total int64
	for _, item := range v.Items() {
		total += size(item)
	}
	if valid {
		v.list.contents.Store(total + 1)
	}
	return total
}

// CacheListContents seeds the new window from its old contents and additions,
// avoiding a full List walk for each collecting pass or Container append.
func (v Value) CacheListContents(contents int64) {
	if v.listWindowValid() {
		v.list.contents.Store(contents + 1)
	}
}
