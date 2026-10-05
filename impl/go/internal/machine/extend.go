package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"slices"
)

// InitializeExtension evaluates only the new code unit, in a prospective state.
func InitializeExtension(previous *State, unit *lower.Unit) (*State, error) {
	s := *previous
	s.Unit = unit
	s.Variables = make([]value.Value, len(unit.Variables))
	copy(s.Variables, previous.Variables)
	s.Definitions = make([]value.Value, len(unit.Definitions))
	copy(s.Definitions, previous.Definitions)
	s.Constants = slices.Clone(previous.Constants)
	for _, text := range unit.Constants[len(previous.Constants):] {
		v, err := constant(text)
		if err != nil {
			return nil, err
		}
		s.Constants = append(s.Constants, v)
	}
	r := Start(&s, len(previous.Unit.Bodies), nil, Limits{})
	r.Initializing = true
	r.Execute(0)
	if r.Status != Completed {
		return nil, &InitError{r.At}
	}
	return &s, nil
}
