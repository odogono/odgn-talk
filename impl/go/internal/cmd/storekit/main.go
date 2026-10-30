// Command storekit checks the memory Store against the language-neutral kit.
package main

import (
	"flag"
	"fmt"
	"os"

	talk "northtalk.org/go"
	"northtalk.org/go/internal/storekit"
	"northtalk.org/go/store"
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
