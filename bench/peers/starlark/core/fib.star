# Naive recursive Fibonacci: function calls, comparison and subtraction.
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

def run(n):
    return fib(n)
