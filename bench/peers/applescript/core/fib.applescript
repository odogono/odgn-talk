-- Naive recursive Fibonacci: handler calls, comparison and subtraction.
on fib(n)
	if n < 2 then return n
	return fib(n - 1) + fib(n - 2)
end fib

on |run|(n)
	return fib(n)
end |run|
