package core

// Lambdas is a loop of calls to a closure that captures a local: function value calls.
func Lambdas(n int64) int64 {
	k := int64(3)
	step := func(acc, i int64) int64 { return acc + i*k }
	total := int64(0)
	for i := int64(1); i <= n; i++ {
		total = step(total, i)
	}
	return total
}
