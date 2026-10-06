# A loop of calls to a small function: the cost of one call and return.
def step(acc, i):
    return acc + i

def run(n):
    total = 0
    for i in range(1, n + 1):
        total = step(total, i)
    return total
