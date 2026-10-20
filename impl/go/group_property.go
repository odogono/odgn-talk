package northtalk

import (
	"fmt"
)

func invokeProperty(prop Prop, o *Object, set bool, input Value) (v Value, err error) {
	defer func() {
		if caught := recover(); caught != nil {
			err = fmt.Errorf("Host panic: %v", caught)
		}
	}()
	if set {
		return Nothing, prop.Set(o, input)
	}
	return prop.Get(o)
}
