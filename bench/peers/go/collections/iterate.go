package collections

import "strconv"

func Iterate(n int64) any {
	values := make([]int64, 32)
	lookup := make(map[string]int64, 32)
	for i := int64(1); i <= 32; i++ {
		values[i-1] = i
		lookup[strconv.FormatInt(i, 10)] = i
	}
	var total int64
	for i := int64(0); i < n; i++ {
		for _, v := range values {
			total += v
		}
		for _, v := range lookup {
			total += v
		}
	}
	return total
}
