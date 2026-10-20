package northtalk

import (
	"context"
	"fmt"
	"time"
)

type groupBackend interface {
	load(LoadOptions) (*Script, error)
	// queue admits a Group-checked input: to a Script, an Object, or every
	// recipient of a Broadcast. how is its Trace input name.
	// A call-value input names its Function Value as fn.
	queue(s *Script, to *Object, fn *Value, m Message, ctx context.Context, how string, decision *Deciding) (DeliveryID, *Pending, error)
	cancelDelivery(DeliveryID)
	object(*ObjectKind, string) error
	setParent(o, parent *Object) error
	dispose(*Object) error
	addLibrary(*Library) error
	replaceLibrary(*Library, CarryOver) ([]Report, error)
	reload(s *Script, source string, carry CarryOver, keepMailbox bool) ([]Report, error)
	extend(s *Script, source string) error
	queued() bool
	pump(time.Time, PumpOptions) (PumpResult, error)
	inspect() Inspection
	counters(*Script) Counters
	control(*Script, string, map[string]any)
	save() ([]byte, error)
	settle(CallID, Settlement) (*Call, error)
	fingerprint() [32]byte
	settleCall(*Call, string, Value, *ScriptError, int64)
	grantNames(*Script) map[string][]string
}

func backendUnsupported(feature string) error {
	return fmt.Errorf("embedded Zig Core: %s is not supported", feature)
}
