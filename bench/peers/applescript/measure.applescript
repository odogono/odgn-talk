-- Measures the Benchmark Suite's AppleScript ports in-process and returns their
-- measurements as JSON, which osascript prints. `bun run bench` runs it on
-- macOS as `osascript measure.applescript <filter> <smoke|""> <count>`; an
-- optional fourth argument names another manifest, for the tests.
-- bench/README.md describes the suite.
use AppleScript version "2.7"
use framework "Foundation"
use scripting additions

-- Each repeat runs the port enough times to take at least this long, as the
-- CPython runner does, so that the timer's resolution doesn't matter.
property repeatSeconds : 0.05

on run argv
	set {filterText, smokeFlag, countText} to items 1 thru 3 of argv
	set portsDir to POSIX path of ((path to me as text) & "::")
	if (count of argv) > 3 then
		set manifestPath to item 4 of argv
	else
		set manifestPath to portsDir & "../../scripts/benchmarks.json"
	end if
	set smoke to smokeFlag is "smoke"
	set measurements to current application's NSMutableArray's array()
	repeat with b in (readManifest(manifestPath)'s objectForKey:"benchmarks")
		set skips to b's objectForKey:"skip"
		set peersSkip to skips is not missing value and (skips's objectForKey:"peers") is not missing value
		if (filterText is "" or (field(b, "name") as text) contains filterText) and not peersSkip then
			(measurements's addObject:measure(portsDir, b, smoke, countText as integer))
		end if
	end repeat
	set json to current application's NSJSONSerialization's dataWithJSONObject:measurements options:0 |error|:(missing value)
	return (current application's NSString's alloc()'s initWithData:json encoding:(current application's NSUTF8StringEncoding)) as text
end run

on readManifest(manifestPath)
	set manifestData to current application's NSData's dataWithContentsOfFile:manifestPath
	if manifestData is missing value then error "cannot read " & manifestPath
	return current application's NSJSONSerialization's JSONObjectWithData:manifestData options:0 |error|:(missing value)
end readManifest

-- A field of a manifest object, as AppleScript sees it.
on field(object, key)
	return item 1 of ((current application's NSArray's arrayWithObject:(object's objectForKey:key)) as list)
end field

-- Compile a Benchmark's port, returning the script whose |run| a Run calls.
-- Starting the port runs only its top level, which defines its handlers.
on load(portsDir, benchmarkName)
	set src to read ((portsDir & benchmarkName & ".applescript") as POSIX file) as «class utf8»
	return run script (src & linefeed & "return me")
end load

-- Load a port and confirm one Run produces the Script's expected output.
on check(portsDir, benchmarkName, theSize)
	try
		set thePort to load(portsDir, benchmarkName)
		set output to thePort's |run|(field(theSize, "n")) as text
	on error message
		error benchmarkName & " on applescript: " & message
	end try
	set expected to field(theSize, "expect")
	if output is not expected then
		error benchmarkName & " on applescript: output " & output & ", expected " & expected
	end if
	return thePort
end check

on now()
	return current application's NSProcessInfo's processInfo()'s systemUptime()
end now

on perRunNs(thePort, n, loops)
	set start to now()
	repeat loops times
		thePort's |run|(n)
	end repeat
	return (now() - start) * 1.0E+9 / loops
end perRunNs

on autorange(thePort, n)
	set loops to 1
	repeat while perRunNs(thePort, n, loops) * loops < repeatSeconds * 1.0E+9
		set loops to loops * 2
	end repeat
	return loops
end autorange

on measure(portsDir, b, smoke, repeats)
	set benchmarkName to field(b, "name")
	if smoke then
		set theSize to b's objectForKey:"smoke"
	else
		set theSize to b
	end if
	set thePort to check(portsDir, benchmarkName, theSize)
	set n to field(theSize, "n")
	set samples to {}
	if smoke then
		set end of samples to perRunNs(thePort, n, 1)
	else
		set loops to autorange(thePort, n)
		repeat repeats times
			set end of samples to perRunNs(thePort, n, loops)
		end repeat
	end if
	set sorted to (current application's NSArray's arrayWithArray:samples)'s sortedArrayUsingSelector:"compare:"
	set sorted to sorted as list
	set half to (count of sorted) div 2
	if (count of sorted) mod 2 is 1 then
		set median to item (half + 1) of sorted
	else
		set median to ((item half of sorted) + (item (half + 1) of sorted)) / 2
	end if
	return {benchmark:benchmarkName, |run|:{medianNs:median, minNs:item 1 of sorted, samples:count of sorted}, runner:"applescript"}
end measure
