-- Records' keys are fixed when the script is compiled, so the maps are
-- Foundation dictionaries.
use framework "Foundation"

on |run|(n)
	set original to current application's NSDictionary's dictionaryWithDictionary:{a:1, b:2, c:3, d:4, e:5, f:6, g:7, h:8}
	set values to original's mutableCopy()
	repeat with i from 1 to n
		values's setObject:i forKey:"a"
	end repeat
	return ((original's objectForKey:"a") as integer) + ((values's objectForKey:"a") as integer)
end |run|
