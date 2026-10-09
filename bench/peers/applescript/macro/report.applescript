on |run|(n)
	set reportLines to {}
	repeat with i from 1 to n
		set end of reportLines to "item " & i & ": " & (i * 2) & linefeed
	end repeat
	set AppleScript's text item delimiters to ""
	return length of (reportLines as text)
end |run|
