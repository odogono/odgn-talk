//go:build wasip1 && wasm

// Command messagelayer-wasi is the Go Core as a WASI Preview 1 reactor.
// Build with GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared.
package main

import (
	"unsafe"

	"github.com/odogono/odgn-talk/impl/go/internal/messagelayer"
)

var (
	session = messagelayer.NewSession()
	input   []byte
	output  []byte // Keep the reply reachable while the Host reads linear memory.
)

// A reactor starts through _initialize, which runs package initialization,
// rather than main. Each instance owns one Session.
func main() {}

// talkBuffer gives the Host space for n bytes until the next talk_buffer.
// A zero length or a length over the sidecar's frame limit returns a null
// pointer. The Host must refresh its memory view after either export, since
// Go may grow linear memory.
//
//go:wasmexport talk_buffer
func talkBuffer(n uint32) unsafe.Pointer {
	if n == 0 || n > messagelayer.MaxFrame {
		input = nil
		return nil
	}
	if int(n) > cap(input) {
		input = make([]byte, n)
	} else {
		input = input[:n]
	}
	return unsafe.Pointer(&input[0])
}

// talkSend returns one reply packed as ptr << 32 | len. The reply remains
// valid until the next talk_send; the Host copies it before that call.
// Exports are called serially, including across interim Host exchanges.
//
//go:wasmexport talk_send
func talkSend(n uint32) uint64 {
	if uint64(n) > uint64(len(input)) {
		output = []byte(`{"ref":-1,"err":{"kind":"protocol error","detail":"frame length exceeds talk_buffer allocation"}}`)
	} else {
		output = session.Send(input[:n])
	}
	return uint64(uintptr(unsafe.Pointer(&output[0])))<<32 | uint64(len(output))
}
