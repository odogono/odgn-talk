// PROTOTYPE: parity runner for the Go Core (throwaway; does not compile).
// Same job as runner.ts: replay case.json on a virtual Clock and diff the
// Trace against expected.trace. Differences from the TS runner are noted.
package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"example.com/talk" // ../api/talk.go
)

type virtualClock struct{ now time.Time }

func (c *virtualClock) Now() time.Time { return c.now }

// ?? time.Time carries a monotonic reading and a location. Two Times with the
//    same instant can print differently. The Core must use only the instant
//    (UnixNano), and TS uses bigint nanoseconds. That's fine for parity, but
//    "Instant resolution is nanoseconds" has to be spec text.

type lines []string

func (l *lines) Record(line string) { *l = append(*l, line) }

func runCase(c Case) ([]string, error) {
	if !talk.ParityCompatible(c.Versions.merge(talk.CoreVersions()), talk.CoreVersions()) {
		return []string{"# skipped: versions"}, nil
	}

	inFlight := map[string]*talk.Call{} // "pricing/r1.c1"
	caps := map[string]*talk.CapabilityDef{}
	for capName, ops := range c.Capabilities {
		var defs []talk.Operation
		for opName, d := range ops {
			defs = append(defs, mockOp(opName, d, func(call *talk.Call) {
				inFlight[call.Script().Name()+"/"+string(call.ID())] = call
			}))
		}
		// ?? Go map iteration order is random, so Operation order here is
		//    random. Harmless only if the Core never lets declaration order
		//    reach anything observable (e.g. diagnostics listing "granted
		//    Operations: …"). TS object order is stable. Spec: sort by name.
		caps[capName] = talk.DefineCapability(capName, defs...)
	}

	clock := &virtualClock{}
	var trace lines
	group := talk.New().NewGroup(talk.GroupOptions{Name: "parity", Clock: clock, Trace: &trace})

	scripts := map[string]*talk.Script{}
	for _, s := range c.Scripts {
		grants := map[string]*talk.Grant{}
		for cap, ops := range s.Grants {
			grants[cap] = caps[cap].Grant(ops, nil)
		}
		src, _ := os.ReadFile(s.Source)
		sc, diags, err := group.Load(talk.LoadOptions{Name: s.Name, Source: string(src), Grants: grants, Limits: c.Limits})
		if err != nil {
			return nil, fmt.Errorf("load %s: %v", s.Name, diags)
		}
		scripts[s.Name] = sc
	}

	for i, step := range c.Steps {
		clock.now = parseInstant(step.Clock)
		trace.Record(fmt.Sprintf("step %d clock=%s", i+1, step.Clock))
		if d := step.Deliver; d != nil {
			scripts[d.To].Deliver(talk.Message{Name: d.Name, Args: caseValues(d.Args)})
		}
		if a := step.Answer; a != nil {
			inFlight[a.Call].Answer(caseValue(a.Value))
		}
		for group.Pump(talk.PumpOptions{}).State == talk.Sliced {
		}
	}
	return trace, nil
}

func main() {
	c := loadCase("case.json")
	got, err := runCase(c)
	if err != nil {
		panic(err)
	}
	want := readLines("expected.trace") // comment lines stripped
	if diff := textDiff(want, got); diff != "" {
		fmt.Println("DIVERGENCE (go core)\n" + diff)
		os.Exit(1)
		// A divergence becomes a corpus case plus a spec fix (ADR 0009),
		// whichever Core turns out to be wrong.
	}
	fmt.Println("ok", strings.Join([]string{c.Versions.Language, c.Versions.CostModel}, "/"))
}

// Placeholders.
type Case struct {
	Versions     versionsDecl
	Limits       talk.Limits
	Capabilities map[string]map[string]opDecl
	Scripts      []struct {
		Name, Source string
		Grants       map[string][]string
	}
	Steps []struct {
		Clock   string
		Deliver *struct {
			To, Name string
			Args     []any
		}
		Answer *struct {
			Call  string
			Value any
		}
	}
}
type versionsDecl struct{ Language, CostModel, Machine string }
type opDecl struct{ Mode string; Args []string; Cost talk.Cost }

func (v versionsDecl) merge(talk.Versions) talk.Versions { panic("sketch") }
func mockOp(string, opDecl, func(*talk.Call)) talk.Operation { panic("sketch") }
func caseValue(any) talk.Value      { panic("sketch") }
func caseValues([]any) []talk.Value { panic("sketch") }
func parseInstant(string) time.Time { panic("sketch") }
func loadCase(string) Case          { panic("sketch") }
func readLines(string) []string     { panic("sketch") }
func textDiff(a, b []string) string { panic("sketch") }
