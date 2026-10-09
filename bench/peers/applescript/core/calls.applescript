-- A loop of calls to a small handler: the cost of one call and return.
on step(acc, i)
	return acc + i
end step

on |run|(n)
	set total to 0
	repeat with i from 1 to n
		set total to step(total, i)
	end repeat
	return total
end |run|
