// Package docs lets the Session Host read Declaration Documentation that only
// the Core can reach. The root package sets the hook in an init function.
package docs

// Function gives the Declaration Documentation of a Function Value's defining
// code, given a northtalk.Value, and false for any other value. A Lambda's is
// empty, and a stale Function Value keeps its code's documentation.
var Function func(value any) (string, bool)
