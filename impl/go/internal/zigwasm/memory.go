package zigwasm

import "github.com/tetratelabs/wazero/experimental"

// reserve is the capacity a new guest memory starts with. A Group with one
// small Script uses 33 pages, so it never copies its memory to grow; wazero's
// default allocator grows page by page and allocates 5.9 MB per Group (#1103).
const reserve = 36 << 16

// linearMemory keeps guest memory on the Go heap, growing by a quarter past
// the reserve.

type linearMemory struct{ buf []byte }

func allocate(capacity, max uint64) experimental.LinearMemory { return &linearMemory{} }

func (m *linearMemory) Reallocate(size uint64) []byte {
	if size > uint64(cap(m.buf)) {
		grown := make([]byte, size, max(size, reserve, uint64(cap(m.buf))*5/4))
		copy(grown, m.buf)
		m.buf = grown
	}
	m.buf = m.buf[:size]
	return m.buf
}
func (m *linearMemory) Free() { m.buf = nil }
