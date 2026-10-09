-- Records' keys are fixed when the script is compiled, so the maps are
-- Foundation dictionaries.
use framework "Foundation"

on |run|(n)
	set values to current application's NSMutableDictionary's dictionary()
	repeat with i from 1 to n
		values's setObject:i forKey:(i as text)
	end repeat
	set total to 0
	repeat with v in (values's allValues() as list)
		set total to total + v
	end repeat
	return total
end |run|
