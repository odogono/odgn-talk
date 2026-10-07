package machine

import "testing"

func TestRecoveryCancellationRetainsOwnerLocals(t *testing.T) {
	const source = `script variable result
on go
 put [1, 2, 3] into kept
 try
  throw "bad"
 offer recover
 catch e before unwind
  try
   choose offer recover
  finally
   put kept into result
  end try
 end try
end go`
	state, err := Initialize(compile(t, source))
	if err != nil {
		t.Fatal(err)
	}
	r := Start(state, len(state.Unit.Bodies)-1, nil, Limits{Fuel: 10000, Alloc: 100000, Depth: 20})
	for r.Frames[len(r.Frames)-1].Code.Unit.Bodies[r.Frames[len(r.Frames)-1].Body].Code[r.Frames[len(r.Frames)-1].PC].Name != "choose-offer" {
		r.Execute(1)
	}
	r.Cancel(1000)
	// Run 96 + activation 48 + owner 64 + five slots 40 + local Values 972.
	// The real owner has no queued finally, but its locals still protect kept.
	if got := r.RetainedSize(); got != 1220 {
		t.Fatalf("retained state=%d, want 1220", got)
	}
	r.Execute(0)
	if r.Status != Cancelled || state.Variables[0].Display() != "[1, 2, 3]" {
		t.Fatalf("status=%v result=%s", r.Status, state.Variables[0].Display())
	}
}
