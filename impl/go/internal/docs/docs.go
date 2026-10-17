// Package docs lets the Session Host read Declaration Documentation that only
// the Core can reach. The root package sets the hook in an init function.
package docs

// Function gives the Declaration Documentation of a Function Value's defining
// code, given a northtalk.Value, and false for any other value. A Lambda's is
// empty, and a stale Function Value keeps its code's documentation.
var Function func(value any) (string, bool)

// FunctionHead gives a Function Value's name, empty for a Lambda, and the
// argument counts it accepts, as functionName and functionArity read them.
// False means the value is not a Function Value; stale values still answer.
var FunctionHead func(value any) (name string, required, total int, ok bool)

// FunctionUnit identifies a carried Function's defining source. Native
// Functions use Function directly. A Lambda has no Declaration Documentation.
var FunctionUnit func(value any) ([32]byte, bool)

// UnitSource is a Script unit or imported Library's exact defining source.
type UnitSource struct {
	Identity     [32]byte
	Name, Source string
}

// ScriptUnits reads current source units without a Host Input or execution.
// The Zig adapter supplies it; native Functions retain their source directly.
var ScriptUnits func(script any) ([]UnitSource, error)

type FunctionReader func(value any) (string, bool)
