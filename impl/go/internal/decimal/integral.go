package decimal

import "math/big"

// Integral rounds exactly at the requested decimal place. Unlike arithmetic,
// this operation must retain every requested digit or report overflow.
func Integral(n Number, places int, mode, op string) (Number, *Error) {
	r := new(big.Rat).Mul(n.Rat(), new(big.Rat).SetInt(pow10(places)))
	q, rem := new(big.Int), new(big.Int)
	q.QuoRem(r.Num(), r.Denom(), rem)
	away := false
	if rem.Sign() != 0 {
		switch mode {
		case "up":
			away = true
		case "floor":
			away = r.Sign() < 0
		case "ceiling":
			away = r.Sign() > 0
		case "half up", "half even":
			c := new(big.Int).Lsh(new(big.Int).Abs(rem), 1).Cmp(r.Denom())
			away = c > 0 || c == 0 && (mode == "half up" || q.Bit(0) != 0)
		}
	}
	if away {
		q.Add(q, big.NewInt(int64(r.Sign())))
	}
	if places > -MinExponent || len(new(big.Int).Abs(q).String()) > Precision {
		return Number{}, &Error{Code: "overflow", Operator: op}
	}
	out, e := checked(q, -places)
	if e != nil {
		return Number{}, &Error{Code: "overflow", Operator: op}
	}
	return out, nil
}
