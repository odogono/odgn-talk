package northtalk

import (
	"slices"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// CalendarImpl supplies zone data and applies gap/overlap rules. An absent zone
// is passed as ""; the Host reads its default from the Call's Grant binding.
type CalendarImpl interface {
	Today(c *Call, zone string) (Value, error)
	Now(c *Call, zone string) (Value, error)
	ToCivil(c *Call, instant Value, zone string) (Value, error)
	ToInstant(c *Call, civil Value, disambiguation string, zone string) (Value, error)
	Offset(c *Call, instant Value, zone string) (Value, error)
	Zone(c *Call, zone string) (Value, error)
}

// CalendarCapability defines the six immediate Calendar Operations. Shapes,
// domain/result refinements and permitted catalogue failures are Core-owned.
func (c *Core) CalendarCapability(impl CalendarImpl, costs Costs) (*CapabilityDef, error) {
	if standardImplementationMissing(impl) {
		return nil, &HostError{InvalidValue, "missing calendar implementation"}
	}
	optionalText := Optional(TextShape)
	unknownZone := ErrorDecl{Code: "unknown zone", Fields: []Field{{Key: "zone", Shape: TextShape}}}
	ops := []Operation{
		{Name: "today", Args: []Shape{optionalText}, Result: CivilDateShape, Do: func(call *Call, args []Value) (Value, error) { return impl.Today(call, calendarText(args, 0)) }},
		{Name: "now", Args: []Shape{optionalText}, Result: CivilDateShape, Do: func(call *Call, args []Value) (Value, error) { return impl.Now(call, calendarText(args, 0)) }},
		{Name: "toCivil", Args: []Shape{InstantShape, optionalText}, Result: CivilDateShape, Do: func(call *Call, args []Value) (Value, error) {
			return impl.ToCivil(call, args[0], calendarText(args, 1))
		}},
		{Name: "toInstant", Args: []Shape{CivilDateShape, optionalText, optionalText}, Result: InstantShape, Do: func(call *Call, args []Value) (Value, error) {
			word, zone := calendarInstantOptions(args)
			return impl.ToInstant(call, args[0], word, zone)
		}},
		{Name: "offset", Args: []Shape{InstantShape, optionalText}, Result: QuantityOf("s"), Do: func(call *Call, args []Value) (Value, error) {
			return impl.Offset(call, args[0], calendarText(args, 1))
		}},
		{Name: "zone", Args: []Shape{optionalText}, Result: TextShape, Do: func(call *Call, args []Value) (Value, error) { return impl.Zone(call, calendarText(args, 0)) }},
	}
	for i := range ops {
		cost, err := standardCost(costs, ops[i].Name)
		if err != nil {
			return nil, err
		}
		ops[i].Cost = cost
		ops[i].Mode = Immediate
		ops[i].Errors = []ErrorDecl{unknownZone}
		if ops[i].Name == "toInstant" {
			ops[i].Errors = append(ops[i].Errors, ErrorDecl{Code: "ambiguous time", Fields: []Field{{Key: "civil", Shape: CivilDateShape}, {Key: "zone", Shape: TextShape}}})
		}
	}
	def, err := c.DefineCapability("calendar", ops...)
	if err != nil {
		return nil, err
	}
	def.checks = map[string]operationChecks{}
	for _, op := range ops {
		name := op.Name
		checks := operationChecks{failure: func(code string, data corevalue.Value) bool {
			if data.Get("zone").Kind != corevalue.Text {
				return false
			}
			return code == "unknown zone" || name == "toInstant" && code == "ambiguous time" && data.Get("civil").Kind == corevalue.CivilDate
		}}
		switch name {
		case "today":
			checks.result = func(v corevalue.Value) bool { return !v.Date.HasTime }
		case "now", "toCivil":
			checks.result = func(v corevalue.Value) bool { return v.Date.HasTime }
		case "toInstant":
			checks.arguments = calendarInstantDomain
		}
		def.checks[name] = checks
	}
	return def, nil
}

func calendarText(args []Value, index int) string {
	if index >= len(args) {
		return ""
	}
	text, _ := args[index].AsText()
	return text
}
func calendarDisambiguation(word string) bool {
	return slices.Contains([]string{"compatible", "earlier", "later", "reject"}, word)
}
func calendarInstantOptions(args []Value) (word, zone string) {
	word = "compatible"
	second := calendarText(args, 1)
	if len(args) == 2 && second != "" && !calendarDisambiguation(second) {
		return word, second
	}
	if second != "" {
		word = second
	}
	return word, calendarText(args, 2)
}
func calendarInstantDomain(args []corevalue.Value) *corevalue.Value {
	var bad corevalue.Value
	if !args[0].Date.HasTime {
		bad = args[0]
	} else if len(args) == 3 && args[1].Kind != corevalue.Nothing && !calendarDisambiguation(args[1].Text) {
		bad = args[1]
	} else {
		return nil
	}
	err := machine.ErrorValue("out of domain", corevalue.Pair{Key: "function", Val: mustText("toInstant")}, corevalue.Pair{Key: "value", Val: bad})
	return &err
}
