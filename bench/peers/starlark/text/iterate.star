def run(n):
    total = 0
    for i in range(n):
        for ch in "NorthTalk rocks!".elems():
            total += len(ch)
    return total
