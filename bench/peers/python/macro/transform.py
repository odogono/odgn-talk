def run(n):
    rows = [{"price": i, "quantity": 2} for i in range(1, n + 1)]
    amounts = [row["price"] * row["quantity"] for row in rows]
    total = 0
    for amount in amounts:
        total += amount
    return total
