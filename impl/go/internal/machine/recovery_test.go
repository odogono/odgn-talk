package machine

import (
	"encoding/json"
	"os"
	"testing"
)

func TestRecoveryExecution(t *testing.T) {
	data, err := os.ReadFile("../../../../tools/machine/recovery-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Source, Result string
		Fuel, Alloc          *int64
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	nestedData, err := os.ReadFile("../../../../tools/machine/recovery-nested-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var nestedCases []struct {
		Name, Source, Result string
		Fuel, Alloc          *int64
	}
	if err := json.Unmarshal(nestedData, &nestedCases); err != nil {
		t.Fatal(err)
	}
	cases = append(cases, nestedCases...)
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			unit := compile(t, c.Source)
			state, err := Initialize(unit)
			if err != nil {
				t.Fatal(err)
			}
			body := -1
			for j, b := range unit.Bodies {
				if b.Checked.Name == "go" {
					body = j
				}
			}
			if body < 0 {
				t.Fatal("missing go")
			}
			r := Start(state, body, nil, Limits{Fuel: 100000, Alloc: 1000000, Depth: 200})
			executeDepthChecked(t, r)
			if c.Fuel != nil && r.Fuel != *c.Fuel {
				t.Fatalf("Fuel=%d want=%d", r.Fuel, *c.Fuel)
			}
			if c.Alloc != nil && r.Alloc != *c.Alloc {
				t.Fatalf("allocation=%d want=%d", r.Alloc, *c.Alloc)
			}
			if r.Status != Completed || r.Result.Display() != c.Result {
				t.Fatalf("status=%v result=%s error=%s limit=%s at=%+v fuel=%d", r.Status, r.Result.Display(), r.Error.Display(), r.Limit, r.At, r.Fuel)
			}
		})
	}
}

func TestRecoveryAccountingBoundaries(t *testing.T) {
	source := "on go\n try\n  throw \"bad\"\n offer recover value\n  return value\n catch e before unwind\n  choose offer recover(7)\n end try\nend go\n"
	unit := compile(t, source)
	state, err := Initialize(unit)
	if err != nil {
		t.Fatal(err)
	}
	r := Start(state, 1, nil, Limits{Fuel: 1000, Alloc: 10000, Depth: 1})
	for unit.Bodies[r.Frames[len(r.Frames)-1].Body].Code[r.Frames[len(r.Frames)-1].PC].Name != "choose-offer" {
		r.Execute(1)
	}
	// 96 Run + 996 owner + (96+292) context + (48+16) activation.
	if r.RetainedSize() != 1544 || r.Fuel != 20 {
		t.Fatalf("state=%d Fuel=%d", r.RetainedSize(), r.Fuel)
	}
	r.Execute(1)
	if r.Fuel != 33 || len(r.OfferRecords) != 2 || r.OfferRecords[1].Kind != "offer-entered" {
		t.Fatalf("Fuel=%d records=%+v", r.Fuel, r.OfferRecords)
	}
	r.Execute(0)
	if r.Status != Completed || r.Fuel != 36 {
		t.Fatalf("status=%v Fuel=%d", r.Status, r.Fuel)
	}
	for _, limit := range []int64{32, 33} {
		r := Start(state, 1, nil, Limits{Fuel: limit, Alloc: 10000, Depth: 1})
		r.Execute(0)
		count := 0
		fuel := int64(29)
		if limit == 33 {
			count = 2
			fuel = 33
		}
		if r.Status != Faulted || r.Fuel != fuel || len(r.OfferRecords) != count {
			t.Fatalf("limit=%d status=%v Fuel=%d records=%+v", limit, r.Status, r.Fuel, r.OfferRecords)
		}
	}
}

func TestRecoveryCleanupRetainedDepth(t *testing.T) {
	source := "function deep\n throw \"bad\"\nend deep\nfunction helper\n return 1\nend helper\nfunction work\n try\n  return deep()\n finally\n  put helper() into ignored\n end try\nend work\non go\n try\n  return work()\n catch e\n  return 7\n end try\nend go\n"
	state, err := Initialize(compile(t, source))
	if err != nil {
		t.Fatal(err)
	}
	r := Start(state, len(state.Unit.Bodies)-1, nil, Limits{Fuel: 1000, Alloc: 10000, Depth: 3})
	r.Execute(0)
	if r.Status != Faulted || r.Limit != "depth" {
		t.Fatalf("status=%v limit=%s", r.Status, r.Limit)
	}
}

func TestRecoveryAcceptanceRetainsActivation(t *testing.T) {
	source := "function fail\n try\n  throw \"bad\"\n finally\n  put 1 into x\n end try\nend fail\non go\n try\n  put fail() into y\n catch e\n  return 1\n end try\nend go\n"
	state, err := Initialize(compile(t, source))
	if err != nil {
		t.Fatal(err)
	}
	r := Start(state, len(state.Unit.Bodies)-1, nil, Limits{Fuel: 1000, Alloc: 10000, Depth: 10})
	for {
		f := r.Frames[len(r.Frames)-1]
		if f.Code.Unit.Bodies[f.Body].Code[f.PC].Name == "catch-accept" {
			break
		}
		r.Execute(1)
	}
	before := r.RetainedSize()
	r.Execute(1)
	if r.RetainedSize() != before {
		t.Fatalf("before=%d after=%d", before, r.RetainedSize())
	}
	r.Execute(0)
	if r.Status != Completed {
		t.Fatal(r.Status)
	}
}

func TestRecoverySearchBoundaries(t *testing.T) {
	data, err := os.ReadFile("../../../../tools/machine/recovery-boundaries.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Source string
		Limit, Fuel  int64
		Line         int
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			state, err := Initialize(compile(t, c.Source))
			if err != nil {
				t.Fatal(err)
			}
			r := Start(state, len(state.Unit.Bodies)-1, nil, Limits{Fuel: c.Limit, Alloc: 10000, Depth: 10})
			r.Execute(0)
			if r.Status != Faulted || r.Limit != "fuel" || r.Fuel != c.Fuel || r.At.Pos.Line != c.Line || len(r.Raises) != 1 || len(r.OfferRecords) != 0 {
				t.Fatalf("status=%v limit=%s Fuel=%d at=%+v raises=%d offers=%d", r.Status, r.Limit, r.Fuel, r.At, len(r.Raises), len(r.OfferRecords))
			}
		})
	}
}

func TestRecoveryCleanupRetainsOperands(t *testing.T) {
	source := "function fail\n throw \"bad\"\nend fail\nfunction work\n try\n  return \"ABC\" & fail()\n finally\n  put 1 into x\n end try\nend work\non go\n try\n  return work()\n catch e\n  return 1\n end try\nend go"
	state, err := Initialize(compile(t, source))
	if err != nil {
		t.Fatal(err)
	}
	r := Start(state, len(state.Unit.Bodies)-1, nil, Limits{Fuel: 1000, Alloc: 10000, Depth: 10})
	for {
		f := r.Frames[len(r.Frames)-1]
		if f.Code.Unit.Bodies[f.Body].Code[f.PC].Name == "catch-accept" {
			break
		}
		r.Execute(1)
	}
	if r.RetainedSize() != 1445 {
		t.Fatal(r.RetainedSize())
	}
	r.Execute(1)
	if r.RetainedSize() != 1445 {
		t.Fatal(r.RetainedSize())
	}
	r.Execute(1)
	if r.RetainedSize() != 1461 {
		t.Fatal(r.RetainedSize())
	}
	r.Execute(0)
	if r.Status != Completed {
		t.Fatal(r.Status)
	}
}
