package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"math"
	"math/big"
	"strings"
)

func saturated(n *big.Int) int64 {
	if !n.IsInt64() {
		return math.MaxInt64
	}
	return n.Int64()
}
func rangeChunk(op, kind string, index, whole value.Value) (value.Value, int64, bool, *value.Value) {
	bad := func(v value.Value) (value.Value, int64, bool, *value.Value) { return value.Value{}, 0, false, &v }
	if kind != "item" || !integerRange(whole) {
		return bad(wrong("list or integer range", whole))
	}
	if !strings.HasPrefix(op, "chunk-get") && !strings.HasPrefix(op, "test-chunk") {
		return bad(wrong("list", whole))
	}
	start, _ := whole.Items[0].Number.Integer()
	end, _ := whole.Items[1].Number.Integer()
	count := new(big.Int).Sub(end, start)
	count.Add(count, big.NewInt(1))
	if count.Sign() < 0 {
		count.SetInt64(0)
	}
	one := func(v value.Value) (*big.Int, *value.Value) {
		if v.Kind != value.Number {
			e := wrong("number", v)
			return nil, &e
		}
		n, ok := v.Number.Integer()
		if !ok {
			e := wrong("integer", v)
			return nil, &e
		}
		if n.Sign() < 0 {
			n.Add(n, count)
			n.Add(n, big.NewInt(1))
		}
		return n, nil
	}
	first, e := one(index)
	var last *big.Int
	if index.Kind == value.Range {
		first, e = one(index.Items[0])
		if e == nil {
			last, e = one(index.Items[1])
		}
	} else {
		last = new(big.Int)
		if first != nil {
			last.Set(first)
		}
	}
	if e != nil {
		return value.Value{}, 0, false, e
	}
	exists := first.Sign() > 0 && last.Cmp(count) <= 0 && first.Cmp(last) <= 0
	if index.Kind != value.Range {
		if !exists {
			return value.Value{}, saturated(count), false, nil
		}
		n := new(big.Int).Add(start, new(big.Int).Sub(first, big.NewInt(1)))
		number, _ := decimal.Round(new(big.Rat).SetInt(n), 0, "+")
		return value.Value{Kind: value.Number, Number: number}, saturated(first), true, nil
	}
	lo, hi := new(big.Int).Set(first), new(big.Int).Set(last)
	if lo.Sign() <= 0 {
		lo.SetInt64(1)
	}
	if hi.Cmp(count) > 0 {
		hi.Set(count)
	}
	if lo.Cmp(hi) > 0 {
		return value.NewList(nil), saturated(count), exists, nil
	}
	result, e2 := rangeListBig(whole, lo, hi)
	if e2 != nil {
		panic(e2)
	}
	return result, saturated(hi), exists, nil
}
