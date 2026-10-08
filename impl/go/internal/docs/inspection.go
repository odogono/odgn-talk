package docs

// Inspection renders passive value rows and actual Object Kind declarations.
// As with Function, the root Core supplies the hook without widening the API.
var Inspection func(value any) ([]string, []string)
