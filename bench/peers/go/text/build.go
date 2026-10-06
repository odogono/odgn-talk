package text

func Build(n int64) any {
	output := ""
	for i := int64(0); i < n; i++ {
		output += "abc"
	}
	return len(output)
}
