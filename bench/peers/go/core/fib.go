package core

// Fib is naive recursive Fibonacci: function calls, comparison and subtraction.
func Fib(n int64) int64 {
	if n < 2 {
		return n
	}
	return Fib(n-1) + Fib(n-2)
}
