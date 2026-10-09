on |run|(n)
	set original to {1, 2, 3, 4, 5, 6, 7, 8}
	copy original to values
	repeat with i from 1 to n
		set item 1 of values to i
	end repeat
	return (item 1 of original) + (item 1 of values)
end |run|
