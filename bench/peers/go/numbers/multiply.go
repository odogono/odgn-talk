package numbers

func Multiply(n int64) any {
	total := 0.0
	for i := int64(1); i <= n; i++ {
		total += 1.25 * float64(i)
	}
	return int64(total * 8)
}
