package northtalk

import (
	"strings"
	"testing"
	"time"
)

func TestOverrideTraceUsesCatalogueWaitName(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n return 7\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(Message{Name: "go", Limits: &LimitOverride{MaxWait: time.Millisecond}}); err != nil {
		t.Fatal(err)
	}
	if _, err = g.Broadcast(Message{Name: "go", Limits: &LimitOverride{Set: OverrideMaxWait}}); err != nil {
		t.Fatal(err)
	}
	if _, err = g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	shown := strings.Join(trace, "\n")
	if !strings.Contains(shown, "limits={maxWaitMs: 1}") || !strings.Contains(shown, "limits={maxWaitMs: 0}") || strings.Contains(shown, "limits={maxWait:") {
		t.Fatal(shown)
	}
}
