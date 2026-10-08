package northtalk

import coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"

func init() {
	coretrace.Host = func(v any) string { return coretrace.Display(v.(Value).inner) }
}
