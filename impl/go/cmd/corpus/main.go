// Command corpus runs the supported Go Conformance Corpus cases.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/odogono/odgn-talk/impl/go/internal/corpus"
)

func main() {
	list := flag.Bool("list", false, "list cases and whether the Go Core supports them")
	check := flag.Bool("check-passing", false, "enforce corpus-passing.txt and report new passing cases")
	flag.Parse()
	root, err := repositoryRoot()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	runner := corpus.Runner{Root: filepath.Join(root, "corpus"), Output: os.Stdout, Backends: corpus.ExecutionBackends()}
	if *check {
		if *list || flag.NArg() != 0 {
			fmt.Fprintln(os.Stderr, "--check-passing cannot be combined with other selections")
			os.Exit(1)
		}
		err = runner.CheckPassing(filepath.Join(root, "impl/go/corpus-passing.txt"))
	} else {
		err = runner.Run(flag.Args(), *list)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func repositoryRoot() (string, error) {
	path, e := os.Getwd()
	if e != nil {
		return "", e
	}
	for {
		if _, e := os.Stat(filepath.Join(path, "spec/data/corpus.toml")); e == nil {
			return path, nil
		}
		parent := filepath.Dir(path)
		if parent == path {
			return "", fmt.Errorf("run corpus inside the NorthTalk checkout")
		}
		path = parent
	}
}
