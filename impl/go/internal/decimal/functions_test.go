package decimal

import "testing"

func TestCorrectlyRoundedFunctions(t *testing.T) {
	for _, tc := range []struct{ name, x, y, want string }{
		{"exp", "1", "0", "2.718281828459045235360287471352662"}, {"ln", "2", "0", "0.6931471805599453094172321214581766"},
		{"sin", "1", "0", "0.841470984807896506652502321630299"}, {"cos", "1", "0", "0.5403023058681397174009366074429766"},
		{"atan", "1", "0", "0.7853981633974483096156608458198757"}, {"asin", "1", "0", "1.570796326794896619231321691639751"},
		{"atan2", "1", "-1", "2.356194490192344928846982537459627"},
	} {
		x, _ := Parse(tc.x)
		y, _ := Parse(tc.y)
		n, e := Function(tc.name, x, y)
		if e != nil || n.String() != tc.want {
			t.Fatalf("%s(%s,%s)=%s %v", tc.name, tc.x, tc.y, n.String(), e)
		}
	}
}
