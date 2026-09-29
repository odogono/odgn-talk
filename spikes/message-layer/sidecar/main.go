// A native sidecar stand-in: reads {packet, 4} frames on stdin and echoes each
// one back on stdout, as a Core's message loop would answer each Host message.
package main

import (
	"bufio"
	"encoding/binary"
	"io"
	"os"
)

func main() {
	r := bufio.NewReader(os.Stdin)
	w := bufio.NewWriter(os.Stdout)
	var hdr [4]byte
	buf := make([]byte, 0, 1<<16)
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return
		}
		n := binary.BigEndian.Uint32(hdr[:])
		buf = buf[:n]
		if _, err := io.ReadFull(r, buf); err != nil {
			return
		}
		w.Write(hdr[:])
		w.Write(buf)
		w.Flush()
	}
}
