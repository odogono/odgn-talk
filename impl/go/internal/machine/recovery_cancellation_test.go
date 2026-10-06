package machine

import (
	"strings"
	"testing"
)

const recoveryCancellationSource = `script variable order = []
script variable mark = 0
function fail
 try
  throw "bad"
 finally
  put 1 after order
 end try
end fail
function work
 try
  try
   put fail() into ignored
  finally
   put 2 after order
  end try
 offer recover
  put 99 after order
 finally
  put 3 after order
 end try
end work
on go
 try
  put work() into ignored
 catch e before unwind
  try
   put 9 into mark
   choose offer recover
  finally
   put 5 after order
  end try
 finally
  put 4 after order
 end try
end go`

func TestRecoveryCancellation(t *testing.T) {
	for _, phase := range []string{"tests", "policy", "nested", "transfer"} {
		t.Run(phase, func(t *testing.T) {
			source := recoveryCancellationSource
			if phase == "nested" {
				source = strings.Replace(source, "put 9 into mark", "try\n throw \"policy\"\ncatch e before unwind\n choose offer unavailable\nend try", 1)
			}
			state, err := Initialize(compile(t, source))
			if err != nil {
				t.Fatal(err)
			}
			r := Start(state, len(state.Unit.Bodies)-1, nil, Limits{Fuel: 10000, Alloc: 100000, Depth: 20})
			found := false
			for n := 0; n < 1000 && (r.Status == Running || r.Status == Preempted); n++ {
				f := r.Frames[len(r.Frames)-1]
				op := f.Code.Unit.Bodies[f.Body].Code[f.PC].Name
				if phase == "tests" && f.Recovery || phase != "tests" && op == "choose-offer" {
					found = true
					break
				}
				r.Execute(1)
			}
			if !found {
				t.Fatalf("missing checkpoint: %v", r.Status)
			}
			if phase == "transfer" {
				r.Execute(1)
			}
			fuel := r.Fuel
			r.Cancel(1000)
			r.Execute(0)
			want := "[1, 2, 3, 4]"
			if phase == "policy" || phase == "nested" {
				want = "[5, 1, 2, 3, 4]"
			}
			lenWant := 4
			if phase == "policy" || phase == "nested" {
				lenWant = 5
			}
			if r.Status != Cancelled || state.Variables[0].Display() != want || state.Variables[1].Display() != "0" || r.Fuel-fuel != int64(11*lenWant) {
				t.Fatalf("status=%v order=%s mark=%s Fuel=%d want=%d", r.Status, state.Variables[0].Display(), state.Variables[1].Display(), r.Fuel, fuel)
			}
			for _, record := range r.OfferRecords {
				if record.Kind == "offer-entered" {
					t.Fatal(record)
				}
			}
		})
	}
}

func TestRecoveryCancellationBudget(t *testing.T) {
	for _, budget := range []int64{0, 10} {
		state, err := Initialize(compile(t, recoveryCancellationSource))
		if err != nil {
			t.Fatal(err)
		}
		r := Start(state, len(state.Unit.Bodies)-1, nil, Limits{Fuel: 10000, Alloc: 100000, Depth: 20})
		for r.Frames[len(r.Frames)-1].Code.Unit.Bodies[r.Frames[len(r.Frames)-1].Body].Code[r.Frames[len(r.Frames)-1].PC].Name != "choose-offer" {
			r.Execute(1)
		}
		r.Cancel(budget)
		r.Execute(0)
		if r.Status != Cancelled || r.CancelLimit != "cleanup" || state.Variables[0].Display() != "[]" || state.Variables[1].Display() != "0" {
			t.Fatalf("budget=%d status=%v limit=%s order=%s", budget, r.Status, r.CancelLimit, state.Variables[0].Display())
		}
	}
}
