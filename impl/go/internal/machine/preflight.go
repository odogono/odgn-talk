package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"math/big"
	"strings"
)

// Construction bounds reject unaffordable work before materializing its
// result. Bounds apply only after validating the operands they depend on;
// ordinary operand errors still take their normative instruction charge.
func (r *Run) preflight(f *Frame, i lower.Instruction) bool {
	if r.Initializing {
		return true
	}
	bounded := func(fuel, alloc int64) bool {
		if f.Clause {
			fuel += 4
		}
		if r.Cancelling && fuel > r.CleanupBudget-r.CleanupFuel {
			r.fault("fuel")
			return false
		}
		if !r.Cancelling && r.Limits.Fuel > 0 && fuel > r.Limits.Fuel-r.Fuel {
			r.fault("fuel")
			return false
		}
		if r.Limits.Alloc > 0 && alloc > r.Limits.Alloc-r.Alloc {
			r.fault("alloc")
			return false
		}
		return true
	}
	if i.Name == "bytes-bits" {
		widths := r.State.Constants[i.Operands()[0].Index].Items
		count := i.Operands()[1].Index
		values := f.Stack[len(f.Stack)-count:]
		total := new(big.Int)
		for j, w := range widths {
			width, _ := w.Number.Integer()
			v := values[j]
			if v.Kind != value.Number {
				return true
			}
			n, ok := v.Number.Integer()
			if !ok || n.Sign() < 0 || big.NewInt(int64(n.BitLen())).Cmp(width) > 0 {
				return true
			}
			total.Add(total, width)
		}
		total.Quo(total, big.NewInt(8))
		whole := f.Stack[len(f.Stack)-count-1]
		alloc := saturatingAdd(16, saturatingAdd(int64(len(whole.Bytes)), saturated(total)))
		return bounded(3, alloc)
	}
	n := len(f.Stack)
	if (i.Name == "property" || i.Name == "property-delimited") && i.Operands()[0].Text == "items" {
		if i.Name == "property-delimited" {
			d := f.Stack[n-1]
			if d.Kind != value.Text || d.Text == "" {
				return true
			}
			n--
		}
		v := f.Stack[n-1]
		if integerRange(v) {
			count := measure("items", v)
			return bounded(saturatingAdd(3, count), saturatingAdd(16, saturatingMultiply(24, count)))
		}
	}
	if strings.HasPrefix(i.Name, "chunk-get") || strings.HasPrefix(i.Name, "test-chunk") {
		if strings.HasSuffix(i.Name, "-delimited") {
			d := f.Stack[n-1]
			if d.Kind != value.Text || d.Text == "" {
				return true
			}
			n--
		}
		whole, index := f.Stack[n-1], f.Stack[n-2]
		if i.Operands()[0].Text == "item" && integerRange(whole) {
			a, _ := whole.Items[0].Number.Integer()
			b, _ := whole.Items[1].Number.Integer()
			count := new(big.Int).Add(new(big.Int).Sub(b, a), big.NewInt(1))
			if count.Sign() < 0 {
				count.SetInt64(0)
			}
			resolve := func(v value.Value) (*big.Int, bool) {
				if v.Kind != value.Number {
					return nil, false
				}
				n, ok := v.Number.Integer()
				if ok && n.Sign() < 0 {
					n.Add(n, count)
					n.Add(n, big.NewInt(1))
				}
				return n, ok
			}
			start, end := index, index
			if index.Kind == value.Range {
				start, end = index.Items[0], index.Items[1]
			}
			lo, ok := resolve(start)
			if !ok {
				return true
			}
			hi, ok := resolve(end)
			if !ok {
				return true
			}
			scanned := new(big.Int).Set(count)
			alloc := int64(8)
			if index.Kind == value.Range {
				if lo.Sign() <= 0 {
					lo.SetInt64(1)
				}
				if hi.Cmp(count) > 0 {
					hi.Set(count)
				}
				alloc = 16
				if lo.Cmp(hi) <= 0 {
					scanned.Set(hi)
					length := new(big.Int).Add(new(big.Int).Sub(hi, lo), big.NewInt(1))
					alloc = saturatingAdd(16, saturatingMultiply(24, saturated(length)))
				}
			} else if lo.Sign() > 0 && lo.Cmp(count) <= 0 {
				scanned.Set(lo)
				alloc = 16
			}
			scanned.Add(scanned, big.NewInt(7))
			scanned.Quo(scanned, big.NewInt(8))
			return bounded(saturatingAdd(3, saturated(scanned)), alloc)
		}
	}
	if i.Name != "chunk-set" && i.Name != "chunk-set-delimited" {
		return true
	}
	kind := i.Operands()[0].Text
	d := text(",")
	if i.Name == "chunk-set-delimited" {
		d = f.Stack[n-1]
		n--
	}
	if d.Kind != value.Text || d.Text == "" {
		return true
	}
	whole, index, part := f.Stack[n-2], f.Stack[n-3], f.Stack[n-1]
	if whole.Kind == value.List && kind == "item" {
		if index.Kind == value.Range && part.Kind != value.List {
			return true
		}
		a, b, e := indices(index, len(whole.Items))
		if e != nil || a < 1 || a > b {
			return true
		}
		retained := max(int64(0), a-1)
		if b <= int64(len(whole.Items)) {
			retained = int64(len(whole.Items)) - (b - a + 1)
		}
		count := int64(1)
		if index.Kind == value.Range {
			count = int64(len(part.Items))
		}
		items := saturatingAdd(retained, count)
		return bounded(4+items/8+boolInt(items%8 != 0), Size(part))
	}
	if whole.Kind != value.Text || (kind != "item" && kind != "line") {
		return true
	}
	count := len(spans(kind, whole.Text, d.Text))
	a, b, e := indices(index, count)
	if e != nil || a < 1 || a > b || b <= int64(count) {
		return true
	}
	padding := max(int64(0), a-int64(max(1, count)))
	return bounded(4+padding/8+boolInt(padding%8 != 0), Size(part))
}
func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}
func saturatingAdd(a, b int64) int64 {
	return saturated(new(big.Int).Add(big.NewInt(a), big.NewInt(b)))
}
func saturatingMultiply(a, b int64) int64 {
	return saturated(new(big.Int).Mul(big.NewInt(a), big.NewInt(b)))
}
