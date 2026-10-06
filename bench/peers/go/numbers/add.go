package numbers

func Add(n int64) any {
	total := 0.0
	for i := int64(1); i <= n; i++ {
		total += 0.125
	}
	return int64(total * 8)
}
