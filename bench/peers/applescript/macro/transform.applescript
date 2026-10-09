-- Lists held in a script object's properties, as `l's rows`, are read by
-- reference; the same reads of a local list slow down as it grows.
on |run|(n)
	script l
		property rows : {}
		property amounts : {}
	end script
	repeat with i from 1 to n
		set end of l's rows to {price:i, quantity:2}
	end repeat
	repeat with r in l's rows
		set end of l's amounts to (price of r) * (quantity of r)
	end repeat
	set total to 0
	repeat with amount in l's amounts
		set total to total + amount
	end repeat
	return total
end |run|
