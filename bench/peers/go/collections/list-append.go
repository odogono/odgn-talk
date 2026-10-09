package collections

func ListAppend(n int64) any {
	original := []int64{-1}
	values := make([]int64, len(original), n+1)
	copy(values, original)
	for i := int64(1); i <= n; i++ {
		values = append(values, i)
	}
	var total int64
	for _, v := range values {
		total += v
	}
	return total + int64(len(original))
}
