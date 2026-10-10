package northtalk

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"io"
	"reflect"
	"slices"
	"strings"
	"sync"
	"time"
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
)

type Core struct {
	mu          sync.Mutex
	units       map[compileKey]*lower.Unit
	objectKinds map[string]*ObjectKind
	// Each comparable StoreImpl's one Segment Coordinator (ADR 0069).
	storeCoordinators map[StoreImpl]*SegmentLifecycle
}

type compileKey struct {
	Identity         [32]byte
	Objects          string
	ObjectProperties string
	PatternSize      int
	Grants           string
}

func New() *Core { return &Core{units: map[compileKey]*lower.Unit{}} }
func CoreVersions() Versions {
	return Versions{Language: generated.Version.Language, CostModel: fmt.Sprint(generated.Costs.Version), Unicode: generated.UnicodeVersion, Core: "go/0.1.0", SaveFormat: "go/6"}
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
func effectiveLimits(l Limits) (Limits, error) {
	defaults := DefaultLimits()
	v, d := reflect.ValueOf(&l).Elem(), reflect.ValueOf(defaults)
	for j := 0; j < v.NumField(); j++ {
		if v.Field(j).Int() < 0 {
			return l, &HostError{InvalidValue, "negative limit"}
		}
		if v.Field(j).Int() == 0 {
			v.Field(j).Set(d.Field(j))
		}
	}
	for _, entry := range generated.Limits.Limit {
		maximum := entry.Minimum
		if entry.Go == "MaxWait" {
			maximum *= int64(time.Millisecond)
		}
		if v.FieldByName(entry.Go).Int() > maximum {
			return l, &HostError{InvalidValue, "limit exceeds supported profile"}
		}
	}
	if l.MaxWait%time.Millisecond != 0 {
		return l, &HostError{InvalidValue, "MaxWait must be whole milliseconds"}
	}
	return l, nil
}
func identity(name, source string) [32]byte {
	return codeIdentity("script", name, source, nil)
}
func codeIdentity(kind, name, source string, imports map[string][32]byte) [32]byte {
	var tree *syntax.Tree
	if len(imports) > 0 {
		tree, _ = syntax.ParseCompact(source)
	}
	return parsedIdentity(kind, name, source, imports, tree)
}

func parsedIdentity(kind, name, source string, imports map[string][32]byte, tree *syntax.Tree) [32]byte {
	hash := sha256.New()
	io.WriteString(hash, "odgn-talk code identity 1\n"+generated.Version.Language+"\n"+fmt.Sprint(generated.Costs.Version)+"\n"+kind+"\n"+name+"\n")
	seen := map[string]bool{}
	if tree != nil {
		for _, n := range tree.Declarations {
			if n.Kind == "use" && !seen[n.Text] {
				seen[n.Text] = true
				if id, ok := imports[n.Text]; ok {
					fmt.Fprintf(hash, "%x\n", id)
				}
			}
		}
	}
	io.WriteString(hash, "source\n")
	io.WriteString(hash, source)
	return [32]byte(hash.Sum(nil))
}
func (e *LoadError) Error() string { return fmt.Sprintf("source rejected: %v", e.Diagnostics) }
func (c *Core) compile(name, source string, options check.Options, imports ...map[string][32]byte) (*lower.Unit, *LoadError) {
	var ids map[string][32]byte
	if len(imports) > 0 {
		ids = imports[0]
	}
	tree, err := syntax.ParseCompact(source)
	kind := "script"
	if options.Library {
		kind = "library"
	}
	return c.compileParsed(name, options, parsedIdentity(kind, name, source, ids, tree), tree, err)
}

// Load and Library compilation share a compact parse for identity, checking and lowering.
func (c *Core) compileParsed(name string, options check.Options, id [32]byte, tree *syntax.Tree, parseErr error) (*lower.Unit, *LoadError) {
	objects := slices.Clone(options.Objects)
	slices.Sort(objects)
	declarations, _ := json.Marshal(options.Grants)
	properties, _ := json.Marshal(struct {
		Objects map[string]map[string]bool
		Owner   map[string]bool
	}{options.ObjectProperties, options.OwnerProperties})
	key := compileKey{id, strings.Join(objects, "\x00"), string(properties), options.PatternSize, string(declarations)}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.units == nil {
		c.units = map[compileKey]*lower.Unit{}
	}
	if unit := c.units[key]; unit != nil {
		return unit, nil
	}
	if parseErr != nil {
		p := parseErr.(*syntax.Error)
		return nil, &LoadError{[]Diagnostic{{Code: p.Code, Message: p.Error(), Unit: name, Line: p.Pos.Line, Col: p.Pos.Column}}}
	}
	checked := check.Check(tree, options)
	if len(checked.Diagnostics) > 0 {
		ds := make([]Diagnostic, len(checked.Diagnostics))
		for j, d := range checked.Diagnostics {
			ds[j] = Diagnostic{Code: d.Code, Message: d.Message, Unit: name, Line: d.Pos.Line, Col: d.Pos.Column}
		}
		return nil, &LoadError{ds}
	}
	unit, err := lower.Compile(checked, name)
	if err != nil {
		panic(err)
	}
	c.units[key] = unit
	return unit, nil
}
