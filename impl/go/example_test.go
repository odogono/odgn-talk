package northtalk_test

import (
	"context"
	"fmt"
	"strings"
	"time"

	talk "northtalk.org/go"
)

// Load a Script into a Group, Request one of its Handlers and Pump the Group
// until the Request settles.
func Example() {
	group := talk.New().NewGroup(talk.GroupOptions{Name: "example"})
	script, err := group.Load(talk.LoadOptions{Name: "math", Source: `
on sum a, b
  return a + b
end sum
`})
	if err != nil {
		panic(err)
	}
	_, pending, err := script.Request(context.Background(), talk.Message{Name: "sum", Args: []talk.Value{talk.Int(2), talk.Int(3)}})
	if err != nil {
		panic(err)
	}
	if _, err := group.Pump(time.Now(), talk.PumpOptions{}); err != nil {
		panic(err)
	}
	result, failure := pending.Result()
	fmt.Println(result, failure == nil)
	// Output: 5 true
}

// A Script variable keeps its value between Requests, and a Pump runs every
// Delivery waiting in the Group.
func ExampleGroup_Pump() {
	group := talk.New().NewGroup(talk.GroupOptions{})
	script, err := group.Load(talk.LoadOptions{Name: "counter", Source: `
script variable count = 0
on bump
  put count + 1 into count
  return count
end bump
`})
	if err != nil {
		panic(err)
	}
	var pending []*talk.Pending
	for range 3 {
		_, p, err := script.Request(context.Background(), talk.Message{Name: "bump"})
		if err != nil {
			panic(err)
		}
		pending = append(pending, p)
	}
	result, err := group.Pump(time.Now(), talk.PumpOptions{})
	if err != nil {
		panic(err)
	}
	fmt.Println(result.State == talk.Idle)
	for _, p := range pending {
		value, _ := p.Result()
		fmt.Println(value)
	}
	// Output:
	// true
	// 1
	// 2
	// 3
}

// Define a Capability with a Go function as its Operation, grant it to a
// Script, and call it from the Script with `ask`.
func ExampleCore_DefineCapability() {
	core := talk.New()
	shout, err := core.DefineCapability("shout", talk.Operation{
		Name:   "loud",
		Mode:   talk.Immediate,
		Args:   []talk.Shape{talk.TextShape},
		Result: talk.TextShape,
		Do: func(_ *talk.Call, args []talk.Value) (talk.Value, error) {
			text, _ := args[0].AsText()
			return talk.Text(strings.ToUpper(text))
		},
	})
	if err != nil {
		panic(err)
	}
	group := core.NewGroup(talk.GroupOptions{})
	script, err := group.Load(talk.LoadOptions{
		Name:   "greeter",
		Source: "on greet name\n  ask shout to loud \"hello \" & name\n  return it\nend greet\n",
		Grants: map[string]*talk.Grant{"shout": shout.GrantAll(nil)},
	})
	if err != nil {
		panic(err)
	}
	name, err := talk.Text("ada")
	if err != nil {
		panic(err)
	}
	_, pending, err := script.Request(context.Background(), talk.Message{Name: "greet", Args: []talk.Value{name}})
	if err != nil {
		panic(err)
	}
	if _, err := group.Pump(time.Now(), talk.PumpOptions{}); err != nil {
		panic(err)
	}
	value, _ := pending.Result()
	text, _ := value.AsText()
	fmt.Println(text)
	// Output: HELLO ADA
}
