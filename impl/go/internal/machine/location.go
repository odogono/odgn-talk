package machine

import "github.com/odogono/odgn-talk/impl/go/internal/check"

// Generated Lambda body names identify code; errors name its enclosing body.
func enclosingHandler(body *check.Body) string {
	for body.Kind == "lambda" && body.Parent != nil {
		body = body.Parent
	}
	return body.Name
}

func codeName(code *State, body int) string {
	name := code.Unit.Bodies[body].CodeName
	if name == "" {
		name = code.Unit.Name
	}
	return name
}
func (r *Run) CodeName() string {
	if len(r.Frames) == 0 {
		return r.State.Unit.Name
	}
	f := r.Frames[len(r.Frames)-1]
	return codeName(f.Code, f.Body)
}
