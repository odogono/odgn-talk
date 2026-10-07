def run(n):
    values = {str(i): i for i in range(1, n + 1)}
    total = 0
    for v in values.values():
        total += v
    return total
