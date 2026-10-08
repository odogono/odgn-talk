// Package storekit drives Host Stores through the language-neutral Store kit.
package storekit

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/corpus"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"github.com/odogono/odgn-talk/impl/go/store"
)

// Run checks every sequence, stopping with the first divergent step.
func Run(root string, makeStore func(store.Quotas) talk.StoreImpl) (int, error) {
	files, err := filepath.Glob(filepath.Join(root, "*.toml"))
	if err != nil {
		return 0, err
	}
	if len(files) == 0 {
		return 0, fmt.Errorf("No Store kit files in %s", root)
	}
	count := 0
	for _, file := range files {
		b, err := os.ReadFile(file)
		if err != nil {
			return count, err
		}
		setup, err := corpus.ReadTOML(string(b))
		if err != nil {
			return count, err
		}
		for _, raw := range setup["sequence"].([]any) {
			seq := raw.(corpus.Setup)
			quotas := setup["quotas"].(corpus.Setup)
			if own, ok := seq["quotas"].(corpus.Setup); ok {
				quotas = own
			}
			impl := makeStore(store.Quotas{Size: quotas["size"].(int64), Keys: quotas["keys"].(int64), Value: quotas["value"].(int64)})
			steps := seq["steps"].([]any)
			calls, err := callsFor(steps)
			if err != nil {
				return count, err
			}
			// Each begun Segment's enrolled Grants, in enrollment order, as
			// the Core gives them to the hooks (ADR 0069).
			enrolled := map[string][]talk.SegmentGrant{}
			for i, raw := range steps {
				step := raw.(corpus.Setup)
				in := step["in"].(string)
				c := calls[in+" "+grantKey(step)]
				phase := step["do"].(string)
				grant := talk.SegmentGrant{GrantName: c.GrantName(), Binding: c.Binding()}
				switch phase {
				case "begin", "commit", "rollback":
					grants := enrolled[in]
					if phase == "begin" || grants == nil {
						grants = []talk.SegmentGrant{grant}
					}
					if phase == "begin" {
						enrolled[in] = grants
					} else {
						delete(enrolled, in)
					}
					context := talk.SegmentContext{Group: c.Group(), SegmentID: c.SegmentID(), Binding: grants[0].Binding, ScriptName: c.ScriptName(), RunID: c.RunID(), GrantName: grants[0].GrantName, Grants: grants}
					var result talk.EffectResult
					switch phase {
					case "begin":
						result = impl.Begin(context)
					case "commit":
						result = impl.Commit(context)
					case "rollback":
						result = impl.Rollback(context)
					}
					want, _ := step["status"].(string)
					if want == "" {
						want = "ok"
					}
					if string(result.Status) != want {
						return count, fmt.Errorf("%s: %s, step %d: expected status %s; got %s (%s)", filepath.Base(file), seq["name"], i+1, want, result.Status, result.Detail)
					}
				default:
					if grants := enrolled[in]; grants != nil && segmentBound[phase] && !slices.ContainsFunc(grants, func(g talk.SegmentGrant) bool { return g.GrantName == grant.GrantName }) {
						enrolled[in] = append(grants, grant)
					}
					args := talk.Nothing
					if raw, ok := step["args"].(string); ok {
						args, err = display(raw)
						if err != nil {
							return count, err
						}
					}
					actual, failure := operate(impl, c, phase, args)
					if expected, ok := step["error"].(string); ok {
						want, err := display(expected)
						if err != nil {
							return count, err
						}
						var script *talk.ScriptError
						if !errors.As(failure, &script) {
							return count, fmt.Errorf("%s: %s, step %d: expected %s; got %v", filepath.Base(file), seq["name"], i+1, want, failure)
						}
						code, _ := talk.Text(script.Code)
						fields := append([]talk.Pair{talk.KV("code", code)}, script.Data.Entries()...)
						got, _ := talk.Map(fields...)
						if got.String() != want.String() {
							return count, fmt.Errorf("%s: %s, step %d: expected %s; got %s", filepath.Base(file), seq["name"], i+1, want, got)
						}
					} else {
						expected, _ := step["gives"].(string)
						if expected == "" {
							expected = "nothing"
						}
						want, err := display(expected)
						if err != nil {
							return count, err
						}
						if failure != nil || actual.String() != want.String() {
							return count, fmt.Errorf("%s: %s, step %d: expected %s; got %s (%v)", filepath.Base(file), seq["name"], i+1, want, actual, failure)
						}
					}
				}
			}
			count++
		}
	}
	return count, nil
}

var segmentBound = map[string]bool{"set": true, "delete": true, "increment": true, "swap": true}

// grantKey names a step's Grant: its kit name, default store, and binding.
func grantKey(step corpus.Setup) string {
	grant, _ := step["grant"].(string)
	if grant == "" {
		grant = "store"
	}
	name, _ := step["store"].(string)
	if name == "" {
		name = "default"
	}
	return grant + " " + name
}
func display(source string) (talk.Value, error) {
	v, err := value.ParseDisplay(source, nil)
	if err != nil {
		return talk.Nothing, err
	}
	b, err := value.Encode(v, false)
	if err != nil {
		return talk.Nothing, err
	}
	return talk.DecodeValue(b, nil)
}
func operate(s talk.StoreImpl, c *talk.Call, op string, args talk.Value) (talk.Value, error) {
	key, _ := args.Index(1).AsText()
	switch op {
	case "get":
		return s.Get(c, key, args.Index(2))
	case "set":
		return talk.Nothing, s.Set(c, key, args.Index(2))
	case "delete":
		return talk.Nothing, s.Delete(c, key)
	case "keys":
		prefix, _ := args.Index(1).AsText()
		return s.Keys(c, prefix)
	case "increment":
		return s.Increment(c, key, args.Index(2))
	case "swap":
		b, err := s.Swap(c, key, args.Index(2), args.Index(3))
		return talk.Bool(b), err
	}
	return talk.Nothing, fmt.Errorf("Unknown Store kit Operation %s", op)
}

// Calls are opaque: acquire real Calls through an unbound capture Capability.
// One Run per kit Segment captures every kit Grant within the same Segment,
// then keeps only the ownership metadata the Store is entitled to read.
func callsFor(steps []any) (map[string]*talk.Call, error) {
	keys, ids := []string{}, []string{}
	seenKeys, seenIDs := map[string]bool{}, map[string]bool{}
	for _, raw := range steps {
		s := raw.(corpus.Setup)
		key := grantKey(s)
		id := s["in"].(string)
		if !seenKeys[key] {
			keys = append(keys, key)
			seenKeys[key] = true
		}
		if !seenIDs[id] {
			ids = append(ids, id)
			seenIDs[id] = true
		}
	}
	calls := map[string]*talk.Call{}
	core := talk.New()
	def, err := core.DefineCapability("capture", talk.Operation{Name: "capture", Mode: talk.Immediate, Args: []talk.Shape{talk.TextShape, talk.TextShape}, Result: talk.NothingShape, Do: func(c *talk.Call, args []talk.Value) (talk.Value, error) {
		id, _ := args[0].AsText()
		key, _ := args[1].AsText()
		calls[id+" "+key] = c
		return talk.Nothing, nil
	}})
	if err != nil {
		return nil, err
	}
	grants := map[string]*talk.Grant{}
	var source strings.Builder
	source.WriteString("on capture label\n")
	for i, key := range keys {
		grant := fmt.Sprintf("st%d", i)
		grants[grant] = def.GrantAll(key[strings.Index(key, " ")+1:])
		fmt.Fprintf(&source, "ask %s to capture label, %q\n", grant, key)
	}
	source.WriteString("end capture\n")
	group := core.NewGroup(talk.GroupOptions{})
	script, err := group.Load(talk.LoadOptions{Name: "kit", Source: source.String(), Grants: grants})
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		label, _ := talk.Text(id)
		if _, err := script.Deliver(talk.Message{Name: "capture", Args: []talk.Value{label}}); err != nil {
			return nil, err
		}
		result, err := group.Pump(time.Unix(0, 0), talk.PumpOptions{})
		if err != nil {
			return nil, err
		}
		for _, report := range result.Reports {
			if end, ok := report.(*talk.RunEnd); ok && end.Outcome != talk.Completed {
				return nil, fmt.Errorf("Capture failed: %v", end.Error)
			}
		}
	}
	return calls, nil
}
