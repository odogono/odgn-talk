package decimal

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
)

// Snapshot preserves the comparison exponent used by internal range iterators.
func (n Number) Snapshot() string {
	b, _ := json.Marshal([]any{n.coefficient, n.exponent, n.comparisonExponent})
	return string(b)
}
func RestoreSnapshot(s string) (Number, error) {
	var xs []json.RawMessage
	if err := json.Unmarshal([]byte(s), &xs); err != nil || len(xs) != 3 {
		return Number{}, fmt.Errorf("invalid saved decimal")
	}
	var n Number
	if err := json.Unmarshal(xs[0], &n.coefficient); err != nil {
		return n, err
	}
	if err := json.Unmarshal(xs[1], &n.exponent); err != nil {
		return n, err
	}
	if err := json.Unmarshal(xs[2], &n.comparisonExponent); err != nil {
		return n, err
	}
	if n.coefficient != "" {
		c, ok := new(big.Int).SetString(n.coefficient, 10)
		if !ok {
			return Number{}, fmt.Errorf("invalid coefficient")
		}
		if c.IsInt64() {
			n.smallCoefficient = c.Int64()
		}
	}
	if n.exponent < MinExponent || n.exponent > 0 || len(strings.TrimPrefix(n.coefficient, "-")) > Precision {
		return Number{}, fmt.Errorf("invalid saved decimal bounds")
	}
	if n.comparisonExponent != "" {
		if _, ok := new(big.Int).SetString(n.comparisonExponent, 10); !ok {
			return Number{}, fmt.Errorf("invalid comparison exponent")
		}
	}
	return n, nil
}
