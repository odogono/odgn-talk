package storekit

import (
	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/store"
	"testing"
)

func TestMemoryStoreKit(t *testing.T) {
	count, err := Run("../../../../corpus/store-kit", func(q store.Quotas) talk.StoreImpl { return store.New(q) })
	if err != nil {
		t.Fatal(err)
	}
	if count == 0 {
		t.Fatal("No sequences ran")
	}
	t.Logf("%d Store kit sequences passed", count)
}
