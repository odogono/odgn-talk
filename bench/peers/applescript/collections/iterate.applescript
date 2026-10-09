-- Records' keys are fixed when the script is compiled, so the map is a
-- Foundation dictionary.
use framework "Foundation"

on |run|(n)
	set values to {}
	set lookup to current application's NSMutableDictionary's dictionary()
	repeat with i from 1 to 32
		set end of values to i
		lookup's setObject:i forKey:(i as text)
	end repeat
	set total to 0
	repeat n times
		repeat with v in values
			set total to total + v
		end repeat
		repeat with v in (lookup's allValues() as list)
			set total to total + v
		end repeat
	end repeat
	return total
end |run|
