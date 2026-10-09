-- Lists held in a script object's properties, as `l's values`, are read by
-- reference; the same reads of a local list slow down as it grows.
on |run|(n)
	script l
		property original : {-1}
		property values : missing value
	end script
	copy l's original to l's values
	repeat with i from 1 to n
		set end of l's values to i
	end repeat
	set total to 0
	repeat with v in l's values
		set total to total + v
	end repeat
	return total + (count of l's original)
end |run|
