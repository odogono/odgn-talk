def run(n):
    total = 0.0
    for i in range(1, n + 1):
        total += 0.125
    return int(total * 8)
