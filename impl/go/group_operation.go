package northtalk

import (
	"context"
	"fmt"
)

type OperationRef struct{ Capability, Operation string }
type CallFailed struct {
	Script    string
	Call      CallID
	Operation OperationRef
	Detail    string
}

func (*CallFailed) isReport() {}

func invokeOperation(op Operation, c *Call, args []Value) (v Value, err error) {
	if c.group.sessionExpose != nil {
		c.group.sessionExpose(List(args...))
	}
	defer func() {
		if caught := recover(); caught != nil {
			err = fmt.Errorf("Host panic: %v", caught)
		}
	}()
	if op.Mode == Immediate {
		return op.Do(c, args)
	}
	if op.Mode == Suspending {
		return Nothing, op.Start(c, args)
	}
	return Nothing, op.Fire(c, args)
}

func operationContext(mode Mode) (context.Context, context.CancelFunc) {
	if mode == Suspending {
		return context.WithCancel(context.Background())
	}
	return context.Background(), func() {}
}
