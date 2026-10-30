package northtalk_test

import (
	"testing"

	talk "northtalk.org/go"
)

// BenchmarkGroupInstantiation measures one Group with one loaded Script, the
// unit the tenants example creates per tenant (#1052).
func BenchmarkGroupInstantiation(b *testing.B) {
	core := talk.New()
	b.ReportAllocs()
	for b.Loop() {
		g := core.NewGroup(talk.GroupOptions{Name: "tenant"})
		if _, err := g.Load(talk.LoadOptions{Name: "s", Source: "on ping\n return 1\nend ping\n"}); err != nil {
			b.Fatal(err)
		}
	}
}
