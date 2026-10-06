package machine

import "testing"

func TestRecoveryNestedLookupCountsRealOwnerOnce(t *testing.T) {
	const source = `on go
 try
  try
   throw "original"
  offer recover
  catch "original" before unwind
   throw "policy"
  end try
 catch "policy" before unwind
  put offerAvailable("recover") into visible
 catch "policy"
  return visible
 end try
end go`
	state, err := Initialize(compile(t, source))
	if err != nil {
		t.Fatal(err)
	}
	r := Start(state, len(state.Unit.Bodies)-1, nil, Limits{Fuel: 10000, Alloc: 100000, Depth: 20})
	for r.Frames[len(r.Frames)-1].Code.Unit.Bodies[r.Frames[len(r.Frames)-1].Body].Code[r.Frames[len(r.Frames)-1].PC].Name != "call-builtin" {
		r.Execute(1)
	}
	fuel := r.Fuel
	r.Execute(1)
	if r.Fuel-fuel != 8 {
		t.Fatalf("lookup Fuel=%d want8", r.Fuel-fuel)
	}
	r.Execute(0)
	if r.Status != Completed || r.Result.Display() != "false" {
		t.Fatalf("status=%v result=%s", r.Status, r.Result.Display())
	}
}

func TestRecoveryNestedHelperDepth(t *testing.T) {
	const source = `function helper
 return 7
end helper
on go
 try
  throw "original"
 offer recover value
  return value
 catch "original" before unwind
  try
   throw "inner"
  catch "inner" before unwind
   put helper() into replacement
  catch "inner"
  end try
  choose offer recover(replacement)
 end try
end go`
	state, err := Initialize(compile(t, source))
	if err != nil {
		t.Fatal(err)
	}
	r := Start(state, len(state.Unit.Bodies)-1, nil, Limits{Fuel: 10000, Alloc: 100000, Depth: 2})
	r.Execute(0)
	if r.Status != Completed || r.Result.Display() != "7" {
		t.Fatalf("status=%v result=%s limit=%s", r.Status, r.Result.Display(), r.Limit)
	}
}
