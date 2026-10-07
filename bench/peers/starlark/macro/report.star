def run(n):
    lines = []
    for i in range(1, n + 1):
        lines.append("item " + str(i) + ": " + str(i * 2) + "\n")
    return len("".join(lines))
