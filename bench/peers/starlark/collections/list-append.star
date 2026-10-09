def run(n):
    original = [-1]
    values = list(original)
    for i in range(1, n + 1):
        values.append(i)
    total = 0
    for v in values:
        total += v
    return total + len(original)
