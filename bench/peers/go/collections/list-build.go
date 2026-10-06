package collections

func ListBuild(n int64) any {
	values := make([]int64, 0, n)
	for i := int64(1); i <= n; i++ {
		values = append(values, i)
	}
	var total int64
	for _, v := range values {
		total += v
	}
	return total
}
