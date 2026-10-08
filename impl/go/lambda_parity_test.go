package northtalk

import (
	"context"
	"testing"
	"time"
)

func TestCapturedLambdaChargesValuesAndAttributesEnclosingHandler(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go n\n put given x: n / x into f\n return f(0)\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "go", Args: []Value{Int(2)}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, failure := p.Result()
	if failure == nil || failure.Data.Get("error").Get("code").String() != `"division by zero"` {
		t.Fatalf("failure: %v", failure)
	}
	if failure.Data.Get("error").Get("at").Get("handler").String() != `"go"` {
		t.Errorf("handler = %q; want enclosing go", failure.Data.Get("error").Get("at").Get("handler").String())
	}
	if operationalReports(result.Reports)[0].(*RunEnd).Alloc != 48 {
		t.Errorf("capture allocation = %d; want 32 + size(2) = 48", operationalReports(result.Reports)[0].(*RunEnd).Alloc)
	}
}
