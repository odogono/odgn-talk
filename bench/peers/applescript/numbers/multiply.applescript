on |run|(n)
	set total to 0.0
	repeat with i from 1 to n
		set total to total + 1.25 * i
	end repeat
	return round (total * 8)
end |run|
