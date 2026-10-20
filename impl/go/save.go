package northtalk

import (
	"slices"
	"strconv"
	"strings"
)

type RestoreOptions struct {
	Name      string
	OnReady   func()
	Trace     TraceSink
	Libraries []*Library
	Grants    func(script, name string) *Grant
	Resolve   func(kind, id string) (native any, ok bool)
	Mismatch  MismatchPolicy
}
type MismatchPolicy int

const (
	RejectMismatch MismatchPolicy = iota
	VariablesOnly
)

type RestoreResult struct {
	Reports         []Report
	VariablesOnly   bool
	Pending         []PendingCall
	DiscardedRuns   []RunID
	Disposed        []ObjectRef
	DroppedMessages []DeliveryID
	AbandonedCalls  []CallID
}
type ObjectRef struct{ Kind, ID string }
type PendingCall struct {
	ID            CallID
	Script, Grant string
	Operation     OperationRef
	Args          []Value
}
type Settlement struct {
	Answer         *Value
	Fail           *ScriptError
	Reissue, Adopt bool
}

// Save snapshots a Quiescent Group without draining Host Inputs or closing effects.
func (g *Group) Save() ([]byte, error) {
	return g.backend.save()
}

func sortedKeys[V any](m map[string]V) []string {
	keys := []string{}
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
func orderedCalls(m map[CallID]*operationCall) []CallID {
	ids := []CallID{}
	for id := range m {
		ids = append(ids, id)
	}
	slices.SortFunc(ids, compareCallID)
	return ids
}
func compareCallID(a, b CallID) int {
	as, ar, ac := splitCall(a)
	bs, br, bc := splitCall(b)
	if n := cmpString(as, bs); n != 0 {
		return n
	}
	if ar < br {
		return -1
	}
	if ar > br {
		return 1
	}
	if ac < bc {
		return -1
	}
	if ac > bc {
		return 1
	}
	return 0
}
func splitCall(id CallID) (string, int64, int64) {
	at := strings.LastIndex(string(id), "/r")
	if at < 0 {
		return string(id), 0, 0
	}
	script, tail := string(id)[:at], string(id)[at+2:]
	run, call, _ := strings.Cut(tail, ".c")
	r, _ := strconv.ParseInt(run, 10, 64)
	c, _ := strconv.ParseInt(call, 10, 64)
	return script, r, c
}
