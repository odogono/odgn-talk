package macro

func Transform(n int64) any {
	type row struct{ price, quantity int64 }
	rows := make([]row, n)
	for i := int64(1); i <= n; i++ {
		rows[i-1] = row{i, 2}
	}
	amounts := make([]int64, n)
	for i, row := range rows {
		amounts[i] = row.price * row.quantity
	}
	var total int64
	for _, amount := range amounts {
		total += amount
	}
	return total
}
