# A loop of calls to a lambda that captures a local: function value calls.
def run(n):
    k = 3
    step = lambda acc, i: acc + i * k
    total = 0
    for i in range(1, n + 1):
        total = step(total, i)
    return total
