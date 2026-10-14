package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Refuse before preflight, Host resolution, operand mutation or effect admission.
func restrictedOperation(f *Frame, i lower.Instruction) bool {
	switch i.Op {
	case generated.OpLoadVar, generated.OpStoreVar, generated.OpStoreDefinition,
		generated.OpLoadObject, generated.OpMe, generated.OpTarget,
		generated.OpSetProperty, generated.OpSetPropertyComputed,
		generated.OpAsk, generated.OpAskWait, generated.OpTell,
		generated.OpSend, generated.OpSendWait, generated.OpSendNamed, generated.OpSendNamedWait,
		generated.OpSendSpread, generated.OpSendSpreadWait, generated.OpSendUp, generated.OpSendUpWait,
		generated.OpWait, generated.OpWaitFor, generated.OpWaitForAny,
		generated.OpJoinStart, generated.OpJoinAsk, generated.OpJoinSend, generated.OpJoinSendNamed,
		generated.OpJoinSendSpread, generated.OpJoinEnd, generated.OpTimeoutStart, generated.OpTimeoutEnd,
		generated.OpCallValueWait, generated.OpCallHandlerWait, generated.OpVeto, generated.OpPass,
		generated.OpChooseOffer:
		return true
	case generated.OpCallBuiltin:
		name := i.Operands()[0].Text
		return name == "isDisposed" || name == "offerAvailable"
	case generated.OpGetKey, generated.OpGetKeyComputed:
		if f.Stack[len(f.Stack)-1].Kind != value.Object {
			return false
		}
		if i.Op == generated.OpGetKey {
			name, _ := constant(i.Operands()[0].Text)
			return name.Text() != "id"
		}
		key := f.Stack[len(f.Stack)-2]
		return key.Kind != value.Text || key.Text() != "id"
	}
	return false
}
