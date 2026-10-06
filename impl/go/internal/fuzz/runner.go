package fuzz

import (
	"encoding/hex"
	"fmt"
	"slices"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/corpus"
)

// orderedSet iterates in insertion order, like a JavaScript Set, so that an
// nth reference picks the same id as runner.ts.
type orderedSet struct{ items []string }

func (s *orderedSet) has(id string) bool { return slices.Contains(s.items, id) }
func (s *orderedSet) add(id string) {
	if !s.has(id) {
		s.items = append(s.items, id)
	}
}
func (s *orderedSet) remove(id string) {
	if i := slices.Index(s.items, id); i >= 0 {
		s.items = slices.Delete(s.items, i, i+1)
	}
}
func (s *orderedSet) clear()         { s.items = nil }
func (s *orderedSet) list() []string { return slices.Clone(s.items) }

func choose(items []string, nth int) (string, bool) {
	if len(items) == 0 {
		return "", false
	}
	return items[(nth%len(items)+len(items))%len(items)], true
}

func listIDs(raw string, ok bool) []string {
	if !ok {
		raw = "[]"
	}
	var out []string
	for _, id := range strings.Split(strings.TrimSuffix(strings.TrimPrefix(raw, "["), "]"), ", ") {
		if id != "" {
			out = append(out, id)
		}
	}
	return out
}

func field(r corpus.Record, key string) (string, bool) {
	for _, f := range r.Fields {
		if f.Key == key {
			return f.Raw, true
		}
	}
	return "", false
}

func id(r corpus.Record) string {
	if len(r.IDs) == 0 {
		return ""
	}
	return r.IDs[0]
}

type savedRefs struct{ runs, deliveries []string }

// Execute replays a case's Host Inputs, resolving each symbolic reference
// against this Core's own Trace exactly as runner.ts's execute does.
func Execute(c Case) (*Execution, error) {
	host, err := corpus.NewReplayHost(c.Setup)
	if err != nil {
		return nil, err
	}
	defer host.Close()
	scripts := map[string]corpus.Setup{}
	for _, raw := range c.Setup["scripts"].([]any) {
		if s, ok := raw.(corpus.Setup); ok {
			name, _ := s["name"].(string)
			scripts[name] = s
		}
	}
	modes := map[string]string{}
	operations, _ := c.Setup["operations"].([]any)
	for _, raw := range operations {
		if o, ok := raw.(corpus.Setup); ok {
			capability, _ := o["capability"].(string)
			name, _ := o["name"].(string)
			if _, seen := modes[capability+"."+name]; !seen {
				modes[capability+"."+name], _ = o["mode"].(string)
			}
		}
	}
	modeOf := func(call, op string) string {
		grant, operation, _ := strings.Cut(op, ".")
		capability := grant
		script, _, _ := strings.Cut(call, "/r")
		if grants, ok := scripts[script]["grants"].(corpus.Setup); ok {
			if g, ok := grants[grant].(corpus.Setup); ok {
				if name, ok := g["capability"].(string); ok {
					capability = name
				}
			}
		}
		return modes[capability+"."+operation]
	}

	var pending, settlements, scheduled, runs, deliveries orderedSet
	saved := map[string]savedRefs{}
	offset := 0
	execution := &Execution{Counts: Counts{Actions: map[string]int{}, Records: map[string]int{}}, Fingerprints: []Fingerprint{}}
	update := func() error {
		trace := host.Trace()
		for _, line := range trace[offset:] {
			r, err := corpus.ParseRecord(line)
			if err != nil {
				return err
			}
			name := r.Name
			if r.Input {
				name = ">" + name
			}
			execution.Counts.Records[name]++
			first := id(r)
			if !r.Input && (r.Name == "seg" || r.Name == "preempt") && len(r.IDs) > 1 && r.IDs[1] == "start" {
				runs.add(first)
			}
			if !r.Input && r.Name == "call" {
				op, _ := field(r, "op")
				_, hasResult := field(r, "result")
				_, hasError := field(r, "error")
				if modeOf(first, op) == "suspending" && !hasResult && !hasError && !scheduled.has(first) {
					pending.add(first)
				}
			}
			if r.Input && (r.Name == "answer" || r.Name == "fail" || r.Name == "settle") {
				pending.remove(first)
				settlements.remove(first)
				if how, _ := field(r, "how"); r.Name == "settle" && (how == "adopt" || how == "reissue") {
					pending.add(first)
				}
			}
			if !r.Input && (r.Name == "abandon" || r.Name == "timeout") {
				pending.remove(first)
			}
			if !r.Input && r.Name == "run" {
				runs.remove(first)
				for _, call := range pending.list() {
					if strings.HasPrefix(call, first+".c") {
						pending.remove(call)
					}
				}
			}
			if r.Input && slices.Contains([]string{"deliver", "request", "decide", "broadcast", "decide-broadcast"}, r.Name) {
				deliveries.add(first)
			}
			if !r.Input && (r.Name == "seg" || r.Name == "preempt" || r.Name == "run") {
				delivery, _ := field(r, "delivery")
				deliveries.remove(delivery)
			}
			if r.Input && r.Name == "restore" {
				runs.clear()
				pending.clear()
				settlements.clear()
				deliveries.clear()
				scheduled.clear()
				from, _ := field(r, "from")
				mode, _ := field(r, "mode")
				if refs, ok := saved[from]; ok && mode != "variables-only" {
					for _, run := range refs.runs {
						runs.add(run)
					}
					for _, d := range refs.deliveries {
						deliveries.add(d)
					}
				}
				for _, call := range listIDs(field(r, "pending")) {
					settlements.add(call)
				}
			}
			if !r.Input && r.Name == "stopped" {
				for _, run := range listIDs(field(r, "discarded")) {
					runs.remove(run)
				}
				for _, call := range listIDs(field(r, "abandoned")) {
					pending.remove(call)
				}
				for _, d := range listIDs(field(r, "dropped")) {
					deliveries.remove(d)
				}
			}
		}
		offset = len(trace)
		return nil
	}
	resolve := func(a Action) (string, error) {
		value := func(fallback string) string {
			if a.Value == nil {
				return fallback
			}
			return *a.Value
		}
		switch a.Kind {
		case "input":
			return a.Line, nil
		case "answer", "fail":
			call, ok := choose(pending.list(), a.Nth)
			if !ok {
				return "", nil
			}
			pending.remove(call)
			scheduled.add(call)
			if a.Kind == "answer" {
				return fmt.Sprintf("> answer %s value=%s", call, value("undefined")), nil
			}
			return fmt.Sprintf("> fail %s error=%s", call, value("undefined")), nil
		case "cancel-run":
			var own []string
			for _, run := range runs.list() {
				if strings.HasPrefix(run, a.Script+"/r") {
					own = append(own, run)
				}
			}
			if run, ok := choose(own, a.Nth); ok {
				return "> cancel-run " + run, nil
			}
			return "", nil
		case "cancel-delivery":
			if d, ok := choose(deliveries.list(), a.Nth); ok {
				return "> cancel-delivery " + d, nil
			}
			return "", nil
		case "restore":
			ids := slices.Clone(host.SaveIDs())
			slices.Reverse(ids)
			save, ok := choose(ids, a.Nth)
			if !ok {
				return "", nil
			}
			if a.VariablesOnly {
				return "> restore from=" + save + " mismatch=variables-only", nil
			}
			return "> restore from=" + save, nil
		case "settle":
			call, ok := choose(settlements.list(), a.Nth)
			if !ok {
				return "", nil
			}
			settlements.remove(call)
			if a.How == "adopt" || a.How == "reissue" {
				pending.add(call)
			}
			line := fmt.Sprintf("> settle %s how=%s", call, a.How)
			switch a.How {
			case "answer":
				line += " value=" + value("0")
			case "fail":
				line += " error=" + value(`{code: "fuzz failure"}`)
			}
			return line, nil
		}
		return "", fmt.Errorf("Unknown fuzz action %s", a.Kind)
	}
	fingerprint := func() string {
		f := host.Group().Fingerprint()
		return hex.EncodeToString(f[:])
	}
	for _, a := range c.Inputs {
		line, err := resolve(a)
		if err != nil {
			return nil, err
		}
		if line == "" {
			execution.Counts.Noops++
			continue
		}
		before := fingerprint()
		if err := host.Apply(line); err != nil {
			return nil, err
		}
		execution.Counts.Applied++
		action, _, _ := strings.Cut(strings.TrimPrefix(line, "> "), " ")
		execution.Counts.Actions[action]++
		execution.Fingerprints = append(execution.Fingerprints, Fingerprint{Action: action, Before: before, After: fingerprint()})
		if err := update(); err != nil {
			return nil, err
		}
		if ids := host.SaveIDs(); action == "save" && len(ids) > 0 {
			saved[ids[len(ids)-1]] = savedRefs{runs: runs.list(), deliveries: deliveries.list()}
		}
	}
	execution.Trace = slices.Clone(host.Trace())
	return execution, nil
}
