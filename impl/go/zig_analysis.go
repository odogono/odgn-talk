package northtalk

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sync"

	"github.com/odogono/odgn-talk/impl/go/internal/analysis"
)

func init() { analysis.Exchange = zigAnalysisExchange }

// Analysis has no Group state or callbacks. A process-wide guest serializes
// these short exchanges and shares the adapter's compiled engine. Keeping it
// separate lets NeedsMore and passive descriptions work before Group creation
// and while a Group is waiting on a Host callback.
var zigAnalysis = sync.OnceValues(func() (func(string, map[string]any) (json.RawMessage, error), error) {
	ctx := context.Background()
	reactor, err := zigEngine().Instantiate(ctx)
	if err != nil {
		return nil, err
	}
	var mu sync.Mutex
	ref := 0
	exchange := func(method string, fields map[string]any) (json.RawMessage, error) {
		mu.Lock()
		defer mu.Unlock()
		ref++
		if fields == nil {
			fields = map[string]any{}
		}
		fields["m"], fields["ref"] = method, ref
		// Source and catalogue text must retain their original Unicode scalars.
		data, err := zigJSON(nil, fields)
		if err != nil {
			return nil, err
		}
		data, err = reactor.Frame(ctx, data)
		if err != nil {
			return nil, err
		}
		var reply struct {
			Ref int             `json:"ref"`
			OK  json.RawMessage `json:"ok"`
		}
		if err := json.Unmarshal(data, &reply); err != nil {
			return nil, err
		}
		if reply.Ref != ref || len(reply.OK) == 0 || string(reply.OK) == "null" {
			return nil, fmt.Errorf("Zig %s analysis reply: %s", method, data)
		}
		return reply.OK, nil
	}
	hello, err := exchange("hello", map[string]any{"protocol": 1, "features": []string{"analysis-v1"}})
	var versions struct {
		Features []string `json:"features"`
	}
	if err == nil {
		err = json.Unmarshal(hello, &versions)
	}
	if err == nil && !slices.Contains(versions.Features, "analysis-v1") {
		err = fmt.Errorf("embedded Zig artifact lacks analysis-v1")
	}
	if err != nil {
		reactor.Close(ctx)
		return nil, err
	}
	return exchange, nil
})

func zigAnalysisExchange(method string, fields map[string]any) (json.RawMessage, error) {
	exchange, err := zigAnalysis()
	if err != nil {
		return nil, err
	}
	return exchange(method, fields)
}
