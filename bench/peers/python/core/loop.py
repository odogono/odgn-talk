# A counting loop: the cost of the loop itself and integer addition.
def run(n):
    total = 0
    for i in range(1, n + 1):
        total += i
    return total
