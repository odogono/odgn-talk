def run(n):
    original = {"a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "f": 6, "g": 7, "h": 8}
    values = dict(original)
    for i in range(1, n + 1):
        values["a"] = i
    return original["a"] + values["a"]
