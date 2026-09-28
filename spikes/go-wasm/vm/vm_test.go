package vm

import "testing"

func TestPrograms(t *testing.T) {
	cases := []struct {
		p    *Program
		n    int64
		want int64
	}{
		{Fib, 20, 6765},
		{Loop, 1000, 499500},
		{Strings, 2500, 2500},
		{Maps, 12000, 5000},
	}
	for _, c := range cases {
		v, _, err := c.p.Run([]Value{I(c.n)}, 1<<40)
		if err != nil || v.N != c.want {
			t.Errorf("n=%d: got %d, %v; want %d", c.n, v.N, err, c.want)
		}
	}
	if _, _, err := Loop.Run([]Value{I(1 << 30)}, 1000); err != ErrFuel {
		t.Errorf("fuel: got %v", err)
	}
}
