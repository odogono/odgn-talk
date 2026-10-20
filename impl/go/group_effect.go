package northtalk

import (
	"fmt"
)

func invokeEffect(hook func(SegmentContext) EffectResult, ctx SegmentContext) (result EffectResult) {
	defer func() {
		if caught := recover(); caught != nil {
			result = EffectResult{EffectUnknown, fmt.Sprintf("Host panic: %v", caught)}
		}
	}()
	result = hook(ctx)
	if result.Status != EffectOK && result.Status != EffectFailed && result.Status != EffectUnknown {
		result = EffectResult{EffectUnknown, "invalid lifecycle result"}
	}
	return
}
