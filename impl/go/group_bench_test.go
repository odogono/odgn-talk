package northtalk_test

import (
	"testing"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// BenchmarkGroupInstantiation measures one Group with one loaded Script, the
// unit the tenants example creates per tenant. Run it with and without
// -tags talk_zig_experimental to compare the Zig guest's cost (#1052).
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
