package northtalk

import (
	"fmt"
	"reflect"
	"sync"
	"time"

	"northtalk.org/go/internal/generated"
)

const (
	StateTooLarge      HostErrorCode = "state too large"
	EffectsPending     HostErrorCode = "effects pending"
	InvalidSave        HostErrorCode = "invalid save"
	SaveMismatch       HostErrorCode = "save mismatch"
	UnknownCall        HostErrorCode = "unknown call"
	ClockBackwards     HostErrorCode = "clock backwards"
	NameReused         HostErrorCode = "name reused"
	ReentrantCall      HostErrorCode = "reentrant call"
	WrongGroup         HostErrorCode = "wrong group"
	EffectStateUnknown HostErrorCode = "effect state unknown"
	InvalidCheckpoint  HostErrorCode = "invalid checkpoint"
)

type Core struct {
	mu          sync.Mutex
	objectKinds map[string]*ObjectKind
	// Each comparable StoreImpl's one Segment Coordinator (ADR 0069).
	storeCoordinators map[StoreImpl]*SegmentLifecycle
	// libraryChecker is the Group whose guest checks CompileLibrary's Libraries.
	libraryChecker *Group
	// zigGuests is the pool of guests its Groups share.
	zigGuests any
}

func New() *Core { return &Core{} }
func CoreVersions() Versions {
	zigEngine()
	return zigCompiled.versions
}
func DefaultLimits() Limits {
	var l Limits
	v := reflect.ValueOf(&l).Elem()
	for _, entry := range generated.Limits.Limit {
		n := entry.Default
		if entry.Go == "MaxWait" {
			n *= int64(time.Millisecond)
		}
		v.FieldByName(entry.Go).SetInt(n)
	}
	return l
}

func (e *LoadError) Error() string { return fmt.Sprintf("source rejected: %v", e.Diagnostics) }
