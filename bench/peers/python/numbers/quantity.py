def run(n):
    total = 0.0
    for i in range(1, n + 1):
        total += (i * 1000) / 1000
    return round(total)
