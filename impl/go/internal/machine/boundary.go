package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
)

// During's following binding token is a name, not a policy flag.
func DecidingClause(b *lower.Body) bool {
	for j := 0; j < len(b.Checked.Node.Flags); j++ {
		switch b.Checked.Node.Flags[j].Raw {
		case "during":
			j++
		case "deciding":
			return true
		}
	}
	return false
}

func QueuePolicy(b *lower.Body) string {
	for j := 0; j < len(b.Checked.Node.Flags); j++ {
		switch flag := b.Checked.Node.Flags[j].Raw; flag {
		case "during":
			j++
		case "queued", "dropping", "replacing":
			return flag
		}
	}
	return ""
}

// Deferred execution keeps the untouched instruction and operands in plain
// Run state. It is not a Script error, and consumes no instruction charge.
// Supported identifies the standalone execution instructions implemented here.
func Supported(i lower.Instruction) bool {

	switch i.Op {
	case generated.OpCallImport, generated.OpMakeImportedFunction, generated.OpAskWait, generated.OpJoinAsk, generated.OpAsk, generated.OpTell, generated.OpConst, generated.OpPop, generated.OpLoad, generated.OpStore, generated.OpMove, generated.OpLoadVar, generated.OpStoreVar, generated.OpLoadDefinition, generated.OpStoreDefinition, generated.OpLoadObject:
		return true
	case generated.OpJump, generated.OpBranchFalse, generated.OpBranchTrue, generated.OpCheckBoolean, generated.OpNot, generated.OpReturn, generated.OpVeto, generated.OpPass, generated.OpCall, generated.OpCallHandler, generated.OpCallHandlerWait, generated.OpCallValueWait, generated.OpWait, generated.OpWaitFor, generated.OpWaitForAny, generated.OpSend, generated.OpSendWait, generated.OpSendUp, generated.OpSendUpWait, generated.OpJoinStart, generated.OpJoinSend, generated.OpJoinEnd, generated.OpSendNamed, generated.OpSendNamedWait, generated.OpJoinSendNamed, generated.OpSendSpread, generated.OpSendSpreadWait, generated.OpJoinSendSpread:
		return true
	case generated.OpAdd, generated.OpSubtract, generated.OpMultiply, generated.OpDivide, generated.OpDiv, generated.OpMod, generated.OpPower, generated.OpNegate, generated.OpConcat, generated.OpRange:
		return true
	case generated.OpEqual, generated.OpNotEqual, generated.OpLess, generated.OpGreater, generated.OpLessOrEqual, generated.OpGreaterOrEqual:
		return true
	case generated.OpList, generated.OpListAppend, generated.OpListExtend, generated.OpMap, generated.OpGetKey, generated.OpGetKeyComputed, generated.OpSetProperty, generated.OpSetPropertyComputed, generated.OpProperty, generated.OpPropertyDelimited:
		return true
	case generated.OpChunkGet, generated.OpChunkGetDelimited, generated.OpChunkSet, generated.OpChunkSetDelimited, generated.OpChunkDelete, generated.OpChunkDeleteDelimited, generated.OpTestChunk, generated.OpTestChunkDelimited:
		return true
	case generated.OpMakePattern, generated.OpContains, generated.OpBeginsWith, generated.OpEndsWith, generated.OpMatches, generated.OpMatchAll:
		return true
	case generated.OpAppend, generated.OpPrepend, generated.OpAppendAll, generated.OpPrependAll, generated.OpIterate, generated.OpIterateTimes, generated.OpNext, generated.OpTimeoutStart, generated.OpTimeoutEnd:
		return true
	case generated.OpTestMap, generated.OpTestList, generated.OpTestListAtLeast, generated.OpListItem, generated.OpListRest, generated.OpMapGet, generated.OpTestConstant, generated.OpTestEqual:
		return true
	case generated.OpThrow, generated.OpCatchAccept, generated.OpCatchNext, generated.OpChooseOffer, generated.OpRaise, generated.OpEndCleanup, generated.OpClauseFail:
		return true
	case generated.OpMe, generated.OpTarget, generated.OpMakeFunction, generated.OpMakeClosure, generated.OpCallValue, generated.OpMatchWhole, generated.OpMatchSearch, generated.OpReplaceStart, generated.OpReplaceNext, generated.OpReplacePut, generated.OpReplaceEnd:
		return true
	case generated.OpMember, generated.OpIsKind, generated.OpIsEmpty, generated.OpCanConvert, generated.OpConvert, generated.OpTestKey, generated.OpTestKeyComputed, generated.OpSetKey, generated.OpSetKeyComputed, generated.OpDeleteKey, generated.OpDeleteKeyComputed:
		return true
	case generated.OpBytesField, generated.OpBytesSized, generated.OpBytesBits, generated.OpBinStart, generated.OpBinLiteral, generated.OpBinInt, generated.OpBinBits, generated.OpBinBytes, generated.OpBinRest, generated.OpBinEnd:
		return true
	case generated.OpCallBuiltin:
		switch i.Operands()[0].Text {
		case "offerAvailable", "upper", "lower", "floor", "ceiling", "truncate", "round", "sqrt", "exp", "ln", "log10", "power", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "fromFloat64", "fromFloat32", "toFloat64", "toFloat32", "year", "month", "day", "hour", "minute", "second", "nanosecond", "weekday", "dayOfYear", "isoWeek", "isoWeekYear", "hasTime", "toCivil", "toInstant", "fromCodePoint", "codePoint", "offset", "kindOf", "objectKind", "isDisposed", "rangeStart", "rangeEnd", "abs", "min", "max", "functionArity", "functionName":
			return true
		}
	}
	return false
}
