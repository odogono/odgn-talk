package northtalk

import (
	"crypto/sha256"
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"reflect"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	ClockBackwards HostErrorCode = "clock backwards"
	NameReused     HostErrorCode = "name reused"
	ReentrantCall  HostErrorCode = "reentrant call"
	WrongGroup     HostErrorCode = "wrong group"
)

type Core struct {
	mu    sync.Mutex
	units map[compileKey]*lower.Unit
}

type compileKey struct {
	Identity    [32]byte
	Objects     string
	PatternSize int
}

func New() *Core { return &Core{units: map[compileKey]*lower.Unit{}} }
func CoreVersions() Versions {
	return Versions{Language: generated.Version.Language, CostModel: fmt.Sprint(generated.Costs.Version), Unicode: generated.UnicodeVersion, Core: "go/0.1.0", SaveFormat: "go/1"}
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
	return sha256.Sum256([]byte("odgn-talk code identity 1\n" + generated.Version.Language + "\n" + fmt.Sprint(generated.Costs.Version) + "\nscript\n" + name + "\nsource\n" + source))
}
func (e *LoadError) Error() string { return fmt.Sprintf("source rejected: %v", e.Diagnostics) }
func (c *Core) compile(name, source string, options check.Options) (*lower.Unit, *LoadError) {
	objects := slices.Clone(options.Objects)
	slices.Sort(objects)
	key := compileKey{identity(name, source), strings.Join(objects, "\x00"), options.PatternSize}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.units == nil {
		c.units = map[compileKey]*lower.Unit{}
	}
	if unit := c.units[key]; unit != nil {
		return unit, nil
	}
	tree, err := syntax.Parse(source)
	if err != nil {
		p := err.(*syntax.Error)
		return nil, &LoadError{[]Diagnostic{{Code: p.Code, Message: p.Error(), Unit: name, Line: p.Pos.Line, Col: p.Pos.Column}}}
	}
	checked := check.Check(tree, options)
	if len(checked.Diagnostics) > 0 {
		ds := make([]Diagnostic, len(checked.Diagnostics))
		for j, d := range checked.Diagnostics {
			ds[j] = Diagnostic{Code: d.Code, Unit: name, Line: d.Pos.Line, Col: d.Pos.Column}
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
