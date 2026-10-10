package messagelayer

// MaxNesting bounds arrays and objects in an incoming JSON frame before any
// recursive decoder sees it. This includes ignored fields and declarations,
// not just Value Encoding. The same bound applies to native and WASI Sessions.
const MaxNesting = 64

func checkNesting(frame []byte) error {
	depth := 0
	quoted, escaped := false, false
	for _, c := range frame {
		if quoted {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				quoted = false
			}
			continue
		}
		switch c {
		case '"':
			quoted = true
		case '[', '{':
			depth++
			if depth > MaxNesting {
				return protocolErrorf("frame nesting exceeds %d", MaxNesting)
			}
		case ']', '}':
			depth--
			// Leave syntax validation to encoding/json, without letting unmatched
			// closes offset the depth of a later hostile container.
			if depth < 0 {
				return protocolErrorf("malformed frame: unmatched closing delimiter")
			}
		}
	}
	return nil
}
