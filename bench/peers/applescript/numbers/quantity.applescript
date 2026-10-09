on |run|(n)
	set total to 0.0
	repeat with i from 1 to n
		set total to total + (i * 1000) / 1000
	end repeat
	return round total
end |run|
