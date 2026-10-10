// Command messagelayer is the Go Core as a sidecar process: the Message Layer
// on stdio, each frame a 4-byte big-endian length and then the JSON
// (spec/09-embedding.md#the-message-layer).
package main

import (
	"fmt"
	"os"

	"github.com/odogono/odgn-talk/impl/go/internal/messagelayer"
)

func main() {
	if err := messagelayer.Serve(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "messagelayer:", err)
		os.Exit(1)
	}
}
