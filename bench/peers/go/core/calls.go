package core

func step(acc, i int64) int64 {
	return acc + i
}

// Calls is a loop of calls to a small function: the cost of one call and return.
func Calls(n int64) int64 {
	total := int64(0)
	for i := int64(1); i <= n; i++ {
		total = step(total, i)
	}
	return total
}
