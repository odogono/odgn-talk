import re
DIGITS = re.compile(r"[0-9]+")

def run(n):
    total = 0
    for i in range(n):
        total += len(DIGITS.findall("a12 b345 c6"))
    return total
