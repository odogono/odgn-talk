package northtalk

import (
	"errors"
	"fmt"
	"slices"

	"github.com/odogono/odgn-talk/impl/go/internal/hostkit"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

func init() {
	hostkit.Immediate = func(group, def any, operation, segment, grant string, binding any, args []any) (any, error) {
		d := def.(*CapabilityDef)
		op, ok := d.ops[operation]
		if !ok || op.Mode != Immediate {
			return Nothing, fmt.Errorf("%s has no immediate Operation %s", d.name, operation)
		}
		values := make([]Value, len(args))
		inner := make([]corevalue.Value, len(args))
		for i, a := range args {
			values[i] = a.(Value)
			inner[i] = values[i].inner
		}
		checks := d.checks[operation]
		if checks.arguments != nil {
			named := []corevalue.Pair{{Key: "capability", Val: mustText(grant)}, {Key: "operation", Val: mustText(operation)}}
			if failure := checks.arguments(inner, binding, named); failure != nil {
				return Nothing, scriptError(*failure)
			}
		}
		call := &Call{group: group.(*Group), scriptName: "kit", runID: RunID(segment), grantName: grant, binding: binding, segmentID: segment, starting: true, charge: func(int64) bool { return true }}
		v, err := op.Do(call, values)
		call.finish()
		// A failure outside the Operation's catalogue reaches a Script as
		// `host error`, as group_operation.go decides.
		var failure *ScriptError
		if errors.As(err, &failure) {
			declared := slices.ContainsFunc(op.Errors, func(e ErrorDecl) bool { return e.Code == failure.Code })
			if !declared || checks.failure != nil && !checks.failure(failure.Code, failure.Data.inner) {
				return Nothing, fmt.Errorf("host error: %w", err)
			}
		}
		return v, err
	}
}
