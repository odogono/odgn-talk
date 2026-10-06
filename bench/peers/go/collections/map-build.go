package collections

import "strconv"

func MapBuild(n int64) any {
	values := make(map[string]int64, n)
	for i := int64(1); i <= n; i++ {
		values[strconv.FormatInt(i, 10)] = i
	}
	var total int64
	for _, v := range values {
		total += v
	}
	return total
}
