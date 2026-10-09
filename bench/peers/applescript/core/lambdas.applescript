-- A loop of calls to a function value that captures a local. AppleScript has
-- no closures, so the function value is a script object that holds the local
-- as a property.
on makeStep(k)
	script
		on call(acc, i)
			return acc + i * k
		end call
	end script
end makeStep

on |run|(n)
	set step to makeStep(3)
	set total to 0
	repeat with i from 1 to n
		set total to step's call(total, i)
	end repeat
	return total
end |run|
