package macro

import (
	"fmt"
	"strings"
)

func Report(n int64) any {
	var output strings.Builder
	for i := int64(1); i <= n; i++ {
		fmt.Fprintf(&output, "item %d: %d\n", i, i*2)
	}
	return output.Len()
}
