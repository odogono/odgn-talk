package machine

import (
	"fmt"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

// Keep the original union-based definition as an independent oracle through
// calls, returns, catch activations, retained cleanups and cancellation.
func checkRealDepth(t *testing.T, r *Run) {
	t.Helper()
	owners := map[int]bool{}
	for _, f := range r.CancellationOwners {
		owners[f.ID] = true
	}
	for _, scope := range r.Cancellation {
		id := scope.Frame.ID
		if scope.Frame.OwnerID != 0 {
			id = scope.Frame.OwnerID
		}
		owners[id] = true
	}
	for _, c := range r.Recoveries {
		for _, f := range c.Retained {
			if !f.Recovery {
				owners[f.ID] = true
			}
		}
	}
	for _, f := range r.Frames {
		if !f.Recovery {
			owners[f.ID] = true
		}
	}
	for range 2 {
		if got := r.realDepth(); got != len(owners) {
			t.Fatalf("depth=%d want=%d status=%v at=%s", got, len(owners), r.Status, r.At.Name)
		}
	}
}

func executeDepthChecked(t *testing.T, r *Run) {
	t.Helper()
	checkRealDepth(t, r)
	for n := 0; r.Status == Running || r.Status == Preempted; n++ {
		if n == 100000 {
			t.Fatal("Run did not finish")
		}
		r.Execute(1)
		checkRealDepth(t, r)
	}
}

func TestCallDepthBoundaryAfterReturns(t *testing.T) {
	for _, n := range []int{4, 998, 999} {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			source := fmt.Sprintf(`function recurse n
 if n = 0 then
  return 0
 end if
 return recurse(n - 1)
end recurse
on go
 put recurse(4) into ignored
 return recurse(%d)
end go`, n)
			state, err := Initialize(compile(t, source))
			if err != nil {
				t.Fatal(err)
			}
			r := Start(state, len(state.Unit.Bodies)-1, nil, Limits{Depth: 1000})
			executeDepthChecked(t, r)
			if n < 999 {
				if r.Status != Completed || r.Result.Display() != "0" || r.realDepth() != 0 {
					t.Fatalf("status=%v result=%s depth=%d", r.Status, r.Result.Display(), r.realDepth())
				}
			} else if r.Status != Faulted || r.Limit != "depth" || r.At.Name != "call" {
				t.Fatalf("status=%v limit=%s at=%s", r.Status, r.Limit, r.At.Name)
			}
		})
	}
}

func TestRealDepthChecksDoNotAllocate(t *testing.T) {
	state, err := Initialize(compile(t, "function recurse\n return recurse()\nend recurse\non go\n return recurse()\nend go\n"))
	if err != nil {
		t.Fatal(err)
	}
	r := Start(state, len(state.Unit.Bodies)-1, nil, Limits{Depth: 1000})
	r.Execute(0)
	if r.Status != Faulted || r.Limit != "depth" || r.realDepth() != 1000 {
		t.Fatalf("status=%v limit=%s depth=%d", r.Status, r.Limit, r.realDepth())
	}
	if got := testing.AllocsPerRun(100, func() { r.realDepth() }); got != 0 {
		t.Fatalf("depth checks allocate %g times per call", got)
	}
}

func BenchmarkCallDepth(b *testing.B) {
	tree, err := syntax.Parse("function recurse\n return recurse()\nend recurse\non go\n return recurse()\nend go\n")
	if err != nil {
		b.Fatal(err)
	}
	unit, err := lower.Compile(check.Check(tree, check.Options{}), "depth")
	if err != nil {
		b.Fatal(err)
	}
	state, err := Initialize(unit)
	if err != nil {
		b.Fatal(err)
	}
	for _, depth := range []int{100, 500, 1000} {
		b.Run(fmt.Sprint(depth), func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				r := Start(state, len(unit.Bodies)-1, nil, Limits{Depth: depth})
				r.Execute(0)
				if r.Status != Faulted || r.Limit != "depth" {
					b.Fatalf("status=%v limit=%s", r.Status, r.Limit)
				}
			}
		})
	}
}
