// Command fuzzworker runs differential fuzz cases on the Go Core. It speaks
// tooling/fuzz's worker protocol on stdin and stdout; pass its path to
// northtalk-fuzz with --go-runner.
package main

import (
	"fmt"
	"os"

	"github.com/odogono/odgn-talk/impl/go/internal/fuzz"
)

func main() {
	if err := fuzz.Serve(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
