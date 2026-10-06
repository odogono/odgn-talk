-- Naive recursive Fibonacci: function calls, comparison and subtraction.
local function fib(n)
  if n < 2 then return n end
  return fib(n - 1) + fib(n - 2)
end

function run(n)
  return fib(n)
end
