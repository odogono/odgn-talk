package northtalk

import (
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// userMaxPending is how long confirm, choose and enter wait, as console's read.
const userMaxPending = 2147483647 * time.Millisecond

// UserImpl shows the person running a Script its prompts (chapter 7, ADR
// 0077). An omitted prompt, default or title is "". Confirm, Choose and Enter
// start a suspending call that the Host answers through the Call: Confirm
// with a boolean, Choose with one of items, or with multiple a list of them in
// list order, and Enter with text. Choose and Enter answer Nothing for a
// cancel. Fail with ScriptError `user busy` while the Script has another
// prompt unanswered.
type UserImpl interface {
	Confirm(c *Call, message string) error
	Choose(c *Call, items []string, prompt string, multiple bool) error
	Enter(c *Call, message string, fallback string) error
	Notify(c *Call, message string, title string) error
}

// UserCapability defines the optional user Operations. The binding is ignored.
func (c *Core) UserCapability(impl UserImpl, costs Costs) (*CapabilityDef, error) {
	if standardImplementationMissing(impl) {
		return nil, &HostError{InvalidValue, "missing user implementation"}
	}
	cost := map[string]Cost{}
	for _, name := range []string{"confirm", "choose", "enter", "notify"} {
		opCost, err := standardCost(costs, name)
		if err != nil {
			return nil, err
		}
		cost[name] = opCost
	}
	optionalText := Optional(TextShape)
	options := func(fields ...Field) Shape { return Optional(MapShape(fields...)) }
	busy := []ErrorDecl{{Code: "user busy"}}
	def, err := c.DefineCapability("user",
		Operation{Name: "confirm", Mode: Suspending, Args: []Shape{TextShape}, Result: BoolShape, Cost: cost["confirm"], Errors: busy, MaxPending: userMaxPending,
			Start: func(call *Call, args []Value) error {
				message, _ := args[0].AsText()
				return impl.Confirm(call, message)
			},
		},
		Operation{Name: "choose", Mode: Suspending,
			Args: []Shape{ListOf(TextShape), options(
				Field{Key: "prompt", Shape: optionalText, Optional: true},
				Field{Key: "multiple", Shape: Optional(BoolShape), Optional: true},
			)},
			Result: Optional(OneOf(TextShape, ListOf(TextShape))), Cost: cost["choose"], Errors: busy, MaxPending: userMaxPending,
			Start: func(call *Call, args []Value) error {
				items := make([]string, args[0].Len())
				for i := range items {
					items[i], _ = args[0].Index(i + 1).AsText()
				}
				return impl.Choose(call, items, userOption(args, 1, "prompt").Text, userMultiple(args))
			},
		},
		Operation{Name: "enter", Mode: Suspending,
			Args:   []Shape{TextShape, options(Field{Key: "default", Shape: optionalText, Optional: true})},
			Result: optionalText, Cost: cost["enter"], Errors: busy, MaxPending: userMaxPending,
			Start: func(call *Call, args []Value) error {
				message, _ := args[0].AsText()
				return impl.Enter(call, message, userOption(args, 1, "default").Text)
			},
		},
		Operation{Name: "notify", Mode: FireAndForget,
			Args: []Shape{TextShape, options(Field{Key: "title", Shape: optionalText, Optional: true})},
			Cost: cost["notify"], Errors: []ErrorDecl{},
			Fire: func(call *Call, args []Value) error {
				message, _ := args[0].AsText()
				return impl.Notify(call, message, userOption(args, 1, "title").Text)
			},
		},
	)
	if err != nil {
		return nil, err
	}
	def.checks = map[string]operationChecks{}
	for _, name := range []string{"confirm", "choose", "enter"} {
		def.checks[name] = operationChecks{failure: func(code string, _ corevalue.Value) bool { return code == "user busy" }}
	}
	checks := def.checks["choose"]
	checks.arguments = func(a []corevalue.Value, _ any, _ []corevalue.Pair) *corevalue.Value {
		if len(a[0].Items) == 0 {
			e := machine.ErrorValue("out of domain", corevalue.Pair{Key: "function", Val: mustText("choose")}, corevalue.Pair{Key: "value", Val: a[0]})
			return &e
		}
		return nil
	}
	checks.result = userChosen
	def.checks["choose"] = checks
	return def, nil
}

// userOption is an option the Script gave, or Nothing when it is omitted.
func userOption(args []Value, index int, key string) corevalue.Value {
	if index >= len(args) {
		return corevalue.Value{}
	}
	return args[index].inner.Get(key)
}
func userMultiple(args []Value) bool {
	return userOption(args, 1, "multiple").Bool
}

// userChosen holds a choose answer to chapter 7: Nothing, one of items, or
// with multiple a subsequence of them.
func userChosen(answer corevalue.Value, args []corevalue.Value) bool {
	if answer.Kind == corevalue.Nothing {
		return true
	}
	items := args[0].Items
	multiple := len(args) > 1 && args[1].Get("multiple").Bool
	if !multiple {
		if answer.Kind != corevalue.Text {
			return false
		}
		for _, item := range items {
			if item.Equal(answer) {
				return true
			}
		}
		return false
	}
	if answer.Kind != corevalue.List {
		return false
	}
	at := 0
	for _, item := range answer.Items {
		for at < len(items) && !items[at].Equal(item) {
			at++
		}
		if at == len(items) {
			return false
		}
		at++
	}
	return true
}
