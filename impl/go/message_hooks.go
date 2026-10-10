package northtalk

import "github.com/odogono/odgn-talk/impl/go/internal/messagehooks"

func init() {
	messagehooks.FuelLeft = func(call any) (int64, bool) {
		c := call.(*Call)
		c.mu.Lock()
		defer c.mu.Unlock()
		if !c.starting || c.fuelLeft == nil {
			return 0, false
		}
		return c.fuelLeft()
	}
}
