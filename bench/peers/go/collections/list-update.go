package collections

func ListUpdate(n int64) any {
	original := []int64{1, 2, 3, 4, 5, 6, 7, 8}
	values := append([]int64(nil), original...)
	for i := int64(1); i <= n; i++ {
		values[0] = i
	}
	return original[0] + values[0]
}
