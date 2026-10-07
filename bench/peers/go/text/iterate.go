package text

func Iterate(n int64) any {
	total := 0
	for i := int64(0); i < n; i++ {
		for range "NorthTalk rocks!" {
			total++
		}
	}
	return total
}
