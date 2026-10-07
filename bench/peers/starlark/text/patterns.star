def run(n):
    total = 0
    for i in range(n):
        inside = False
        for ch in "a12 b345 c6".elems():
            digit = ch in "0123456789"
            if digit and not inside:
                total += 1
            inside = digit
    return total
