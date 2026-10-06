// Naive recursive Fibonacci: function calls, comparison and subtraction.
function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

function run(n) {
  return fib(n);
}
