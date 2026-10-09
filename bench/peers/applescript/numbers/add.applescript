on |run|(n)
	set total to 0.0
	repeat with i from 1 to n
		set total to total + 0.125
	end repeat
	return round (total * 8)
end |run|
