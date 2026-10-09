on |run|(n)
	set total to 0
	repeat n times
		repeat with ch in characters of "NorthTalk rocks!"
			set total to total + (length of ch)
		end repeat
	end repeat
	return total
end |run|
