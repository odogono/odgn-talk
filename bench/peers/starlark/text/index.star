def run(n):
    total = 0
    for i in range(1, n + 1):
        if "NorthTalk rocks!"[i % 16] == "o":
            total += 1
    return total
