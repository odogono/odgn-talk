package northtalk

import coretrace "northtalk.org/go/internal/trace"

func init() {
	coretrace.Host = func(v any) string { return coretrace.Display(v.(Value).inner) }
}
