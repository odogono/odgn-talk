package collections

import "maps"

func MapUpdate(n int64) any {
	original := map[string]int64{"a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "f": 6, "g": 7, "h": 8}
	values := maps.Clone(original)
	for i := int64(1); i <= n; i++ {
		values["a"] = i
	}
	return original["a"] + values["a"]
}
