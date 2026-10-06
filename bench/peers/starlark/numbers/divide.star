def run(n):
    total = 0.0
    for i in range(1, n + 1):
        total += i / 8
    return int(total * 8)
