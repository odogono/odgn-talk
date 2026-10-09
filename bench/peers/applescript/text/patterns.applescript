-- AppleScript has no regular expressions, so this scans for digit runs.
on |run|(n)
	set total to 0
	repeat n times
		set inRun to false
		repeat with ch in characters of "a12 b345 c6"
			if ch is in "0123456789" then
				if not inRun then set total to total + 1
				set inRun to true
			else
				set inRun to false
			end if
		end repeat
	end repeat
	return total
end |run|
