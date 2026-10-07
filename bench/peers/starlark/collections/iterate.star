def run(n):
    values = list(range(1, 33))
    lookup = {str(i): i for i in values}
    total = 0
    for i in range(n):
        for v in values:
            total += v
        for v in lookup.values():
            total += v
    return total
