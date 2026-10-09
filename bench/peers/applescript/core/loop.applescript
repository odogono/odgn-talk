-- A counting loop: the cost of the loop itself and integer addition.
on |run|(n)
	set total to 0
	repeat with i from 1 to n
		set total to total + i
	end repeat
	return total
end |run|
