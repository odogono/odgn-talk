package machine

import "github.com/odogono/odgn-talk/impl/go/internal/check"

// Generated Lambda body names identify code; errors name its enclosing body.
func enclosingHandler(body *check.Body) string {
	for body.Kind == "lambda" && body.Parent != nil {
		body = body.Parent
	}
	return body.Name
}
