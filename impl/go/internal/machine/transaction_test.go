package machine

import (
	"reflect"
	"slices"
	"testing"
)

func TestEveryRefusedChargePreservesFrames(t *testing.T) {
	unit := compile(t, `function step x
  return x + 1
end step
on go
  put 0 into total
  repeat 5 times
    put step(total) into total
  end repeat
  return total
end go
`)
	s, err := Initialize(unit)
	if err != nil {
		t.Fatal(err)
	}
	baseline := Start(s, 2, nil, Limits{})
	for baseline.Status == Running || baseline.Status == Preempted {
		before := slices.Clone(baseline.Frames)
		for j := range before {
			before[j].Stack = slices.Clone(before[j].Stack)
			before[j].Locals = slices.Clone(before[j].Locals)
		}
		fuel, alloc := baseline.Fuel, baseline.Alloc
		baseline.Execute(1)
		for _, resource := range []string{"fuel", "alloc"} {
			limits := Limits{}
			if resource == "fuel" {
				limits.Fuel = baseline.Fuel - 1
			} else {
				if baseline.Alloc == alloc {
					continue
				}
				limits.Alloc = baseline.Alloc - 1
			}
			run := Start(s, 2, nil, limits)
			run.Execute(0)
			for j := range run.Frames {
				if len(run.Frames[j].Stack) == 0 {
					run.Frames[j].Stack = nil
				}
			}
			for j := range before {
				if len(before[j].Stack) == 0 {
					before[j].Stack = nil
				}
			}
			if run.Status != Faulted || run.Limit != resource || run.Fuel != fuel || run.Alloc != alloc || !reflect.DeepEqual(run.Frames, before) {
				t.Fatalf("%s refusal at %s after %d Fuel changed frames or charges: status=%v fuel=%d alloc=%d", resource, baseline.At.Name, fuel, run.Status, run.Fuel, run.Alloc)
			}
		}
	}
	if baseline.Status != Completed || baseline.Result.Display() != "5" {
		t.Fatalf("baseline: %+v", baseline)
	}
}
