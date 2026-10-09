on |run|(n)
	set output to ""
	repeat n times
		set output to output & "abc"
	end repeat
	return length of output
end |run|
