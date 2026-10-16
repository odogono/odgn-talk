package northtalk

import (
	"context"
	"fmt"
	"time"
)

// Only the experimental build registers an alternate implementation. Keeping
// this seam in the existing API lets the same Host tests exercise both Cores.
var experimentalGroupFactory func(*Group) groupBackend
var experimentalVersions func() Versions

type groupBackend interface {
	load(LoadOptions) (*Script, error)
	admit(*Script, Message, context.Context, bool) (DeliveryID, *Pending, error)
	broadcast(Message) (BroadcastID, error)
	// decide addresses s, or every recipient when s is nil.
	decide(*Script, context.Context, Message) (string, *Deciding, error)
	pump(time.Time, PumpOptions) (PumpResult, error)
	inspect() Inspection
	counters(*Script) Counters
	control(*Script, string, map[string]any)
	fingerprint() [32]byte
	settleCall(*Call, string, Value, *ScriptError, int64)
	grantNames(*Script) map[string][]string
}

func backendUnsupported(feature string) error {
	return fmt.Errorf("experimental Zig backend: %s is not implemented; see issue #884", feature)
}
