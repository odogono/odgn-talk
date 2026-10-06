// Package core ports the core-execution Benchmarks to Go.
package core

// Loop is a counting loop: the cost of the loop itself and integer addition.
func Loop(n int64) int64 {
	total := int64(0)
	for i := int64(1); i <= n; i++ {
		total += i
	}
	return total
}
