def run(n):
    original = [1, 2, 3, 4, 5, 6, 7, 8]
    values = list(original)
    for i in range(1, n + 1):
        values[0] = i
    return original[0] + values[0]
