package text

func Index(n int64) any {
	total := 0
	for i := int64(1); i <= n; i++ {
		if "NorthTalk rocks!"[i%16] == 'o' {
			total++
		}
	}
	return total
}
