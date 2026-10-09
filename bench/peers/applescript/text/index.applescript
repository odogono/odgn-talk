-- AppleScript compares text ignoring case unless told otherwise.
on |run|(n)
	set total to 0
	considering case
		repeat with i from 1 to n
			if character (i mod 16 + 1) of "NorthTalk rocks!" is "o" then set total to total + 1
		end repeat
	end considering
	return total
end |run|
