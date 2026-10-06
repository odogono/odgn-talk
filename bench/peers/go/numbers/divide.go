package numbers

func Divide(n int64) any {
	total := 0.0
	for i := int64(1); i <= n; i++ {
		total += float64(i) / 8
	}
	return int64(total * 8)
}
