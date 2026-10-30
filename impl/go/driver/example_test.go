package driver_test

import (
	"context"
	"fmt"

	talk "northtalk.org/go"
	"northtalk.org/go/driver"
)

// A Pool pumps each of its Groups when a Delivery or deadline makes it ready,
// so a Host only loads Scripts and sends messages.
func ExamplePool() {
	pool := driver.NewPool(driver.PoolOptions{Workers: 2})
	defer pool.Close()
	core := talk.New()

	var pending []*talk.Pending
	for _, tenant := range []string{"acme", "globex"} {
		member := pool.NewGroup(core, talk.GroupOptions{Name: tenant})
		err := member.Do(func(g *talk.Group) error {
			script, err := g.Load(talk.LoadOptions{Name: "hello", Source: "on hi who\n  return \"hi \" & who\nend hi\n"})
			if err != nil {
				return err
			}
			name, err := talk.Text(tenant)
			if err != nil {
				return err
			}
			_, p, err := script.Request(context.Background(), talk.Message{Name: "hi", Args: []talk.Value{name}})
			pending = append(pending, p)
			return err
		})
		if err != nil {
			panic(err)
		}
	}
	for _, p := range pending {
		<-p.Done()
		value, _ := p.Result()
		text, _ := value.AsText()
		fmt.Println(text)
	}
	// Output:
	// hi acme
	// hi globex
}
