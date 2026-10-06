// Naive recursive Fibonacci: function calls, comparison and subtraction.
const fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2));

export const run = (n: number) => fib(n);
