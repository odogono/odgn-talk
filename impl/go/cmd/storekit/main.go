// Command storekit checks the memory Store against the language-neutral kit.
package main

import (
	"flag"
	"fmt"
	"os"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/storekit"
	"github.com/odogono/odgn-talk/impl/go/store"
)

func main() {
	root := flag.String("root", "../../corpus/store-kit", "Store kit directory")
	flag.Parse()
	count, err := storekit.Run(*root, func(q store.Quotas) talk.StoreImpl { return store.New(q) })
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("PASS %d Store kit sequences\n", count)
}
